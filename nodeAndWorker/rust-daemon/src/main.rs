use anyhow::Result;
use base64::Engine as _;
use clap::Parser;
use futures::StreamExt;
use libp2p::{
    autonat, dcutr, identify, kad, mdns, noise,
    relay,
    request_response::{self, ProtocolSupport},
    swarm::{NetworkBehaviour, Swarm, SwarmEvent},
    tcp, yamux, Multiaddr, PeerId, StreamProtocol,
};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet, VecDeque};
use std::error::Error;
use std::path::PathBuf;
use std::str::FromStr;
use std::sync::{
    atomic::{AtomicU64, AtomicUsize, Ordering},
    Arc, Mutex, OnceLock,
};
use std::time::{Duration, Instant};
use tokio::io::AsyncWriteExt;
use tokio::time;
use axum::body::{Body, Bytes};
use axum::http::StatusCode;
use axum::response::Response;
use axum::{routing::{get, post}, Json, Router};
use tower_http::cors::CorsLayer;
use axum::extract::DefaultBodyLimit;

// ============================================================
//  Codec P2P personnalisé (512 MB pour les poids de modèle)
// ============================================================

mod vryx_codec {
    use async_trait::async_trait;
    use futures::prelude::*;
    use libp2p::StreamProtocol;
    use serde::{de::DeserializeOwned, Serialize};
    use std::{io, marker::PhantomData};

    /// Limite 512 MB — permet le transfert de tranches de poids LLM entre VPS et workers.
    const MAX_SIZE: u64 = 512 * 1024 * 1024;

    pub struct Codec<Req, Resp> {
        phantom: PhantomData<(Req, Resp)>,
    }

    impl<Req, Resp> Default for Codec<Req, Resp> {
        fn default() -> Self { Codec { phantom: PhantomData } }
    }

    impl<Req, Resp> Clone for Codec<Req, Resp> {
        fn clone(&self) -> Self { Self::default() }
    }

    #[async_trait]
    impl<Req, Resp> libp2p::request_response::Codec for Codec<Req, Resp>
    where
        Req: Send + Serialize + DeserializeOwned,
        Resp: Send + Serialize + DeserializeOwned,
    {
        type Protocol = StreamProtocol;
        type Request = Req;
        type Response = Resp;

        async fn read_request<T>(
            &mut self,
            _protocol: &Self::Protocol,
            io: &mut T,
        ) -> io::Result<Self::Request>
        where T: AsyncRead + Unpin + Send {
            let mut buf = Vec::new();
            io.take(MAX_SIZE).read_to_end(&mut buf).await?;
            serde_json::from_slice(&buf)
                .map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e))
        }

        async fn read_response<T>(
            &mut self,
            _protocol: &Self::Protocol,
            io: &mut T,
        ) -> io::Result<Self::Response>
        where T: AsyncRead + Unpin + Send {
            let mut buf = Vec::new();
            io.take(MAX_SIZE).read_to_end(&mut buf).await?;
            serde_json::from_slice(&buf)
                .map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e))
        }

        async fn write_request<T>(
            &mut self,
            _protocol: &Self::Protocol,
            io: &mut T,
            req: Self::Request,
        ) -> io::Result<()>
        where T: AsyncWrite + Unpin + Send {
            let data = serde_json::to_vec(&req)
                .map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e))?;
            io.write_all(&data).await?;
            io.close().await?;
            Ok(())
        }

        async fn write_response<T>(
            &mut self,
            _protocol: &Self::Protocol,
            io: &mut T,
            resp: Self::Response,
        ) -> io::Result<()>
        where T: AsyncWrite + Unpin + Send {
            let data = serde_json::to_vec(&resp)
                .map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e))?;
            io.write_all(&data).await?;
            io.close().await?;
            Ok(())
        }
    }
}

// ============================================================
//  CLI
// ============================================================

#[derive(Parser, Debug)]
#[command(
    author,
    version,
    about = "Vryx DePIN node daemon",
    long_about = None
)]
struct Args {
    /// Port gRPC de l'inference server Python (stage 1 pour initiator, stage 2 pour worker)
    #[arg(short, long, default_value_t = 50051)]
    grpc_port: u16,

    /// Mode de fonctionnement : bootstrap | worker | initiator
    #[arg(short, long, default_value = "worker")]
    mode: String,

    /// Port TCP libp2p (0 = aléatoire)
    #[arg(short, long, default_value_t = 0)]
    p2p_port: u16,

    /// Adresse multiaddr du bootstrap node, ex :
    ///   /ip4/51.222.26.225/tcp/4001/p2p/12D3KooWHNoWUtd7kqWGFzN9hpkF3pysmRMoVXnYqG5vQk7RMveK
    #[arg(short, long)]
    bootstrap_node: Option<String>,

    /// URL de l'API Vryx pour le heartbeat worker (ex: https://vryx.eu)
    /// Laisser vide si pas de heartbeat.
    #[arg(long)]
    api_url: Option<String>,

    /// Fichier de persistance du keypair libp2p (base64).
    /// Si le fichier n'existe pas, il est créé.
    /// Permet de conserver le même PeerId entre les redémarrages.
    #[arg(long)]
    node_key_file: Option<PathBuf>,

    /// ID de l'utilisateur (optionnel, pour le heartbeat)
    #[arg(long)]
    user_id: Option<u64>,

    /// Port de l'API locale Axum (pour le dashboard Electron)
    #[arg(long, default_value_t = 3031)]
    api_port: u16,

    /// Nom du modèle d'IA utilisé (ex: google/gemma-2-2b-it)
    #[arg(long)]
    model: Option<String>,
}

// ============================================================
//  Protocoles P2P
// ============================================================

#[derive(Debug, Clone, Serialize, Deserialize)]
struct TensorRequest {
    /// Type de payload routé en P2P natif (`text`, `vryx.shard.*`, `vryx.dist.*`, ...).
    #[serde(default)]
    kind: String,
    #[serde(with = "base64_vec")]
    data: Vec<u8>,
    dtype: String,
    #[serde(default)]
    compute_time_ns: u64,
    #[serde(default)]
    serialization_time_ns: u64,
    #[serde(default)]
    routing_path: Vec<String>,
    #[serde(default)]
    session_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct TensorResponse {
    #[serde(with = "base64_vec")]
    data: Vec<u8>,
    compute_time_ns: u64,
    serialization_time_ns: u64,
    #[serde(default)]
    prompt_tokens_llm: u64,
    #[serde(default)]
    completion_tokens_llm: u64,
    #[serde(default)]
    total_tokens_llm: u64,
    #[serde(default)]
    vps_delegate_ms: u64,
    #[serde(default)]
    worker_compute_ms: u64,
    #[serde(default)]
    p2p_messages_in: u64,
    #[serde(default)]
    p2p_messages_out: u64,
    #[serde(default)]
    shard_session_id: String,
    #[serde(default)]
    scheduler_workers_used: u32,
    #[serde(default)]
    shard_warmup_sent: u32,
    #[serde(default)]
    compute_time_ms: u64,
}

impl Default for TensorResponse {
    fn default() -> Self {
        Self {
            data: vec![],
            compute_time_ns: 0,
            serialization_time_ns: 0,
            prompt_tokens_llm: 0,
            completion_tokens_llm: 0,
            total_tokens_llm: 0,
            vps_delegate_ms: 0,
            worker_compute_ms: 0,
            p2p_messages_in: 0,
            p2p_messages_out: 0,
            shard_session_id: String::new(),
            scheduler_workers_used: 0,
            shard_warmup_sent: 0,
            compute_time_ms: 0,
        }
    }
}

/// Tableau `routing_path` pour les réponses HTTP/SSE (aligné sur `pipeline_trace_json`).
fn routing_path_from_trace(trace: &serde_json::Value) -> serde_json::Value {
    let mut rp = trace
        .get("routing_path")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();
    if rp.is_empty() {
        if let Some(peers) = trace.get("peers").and_then(|v| v.as_array()) {
            rp = peers.clone();
        }
    }
    serde_json::Value::Array(rp)
}

fn env_u64_clamped(name: &str, default: u64, min: u64, max: u64) -> u64 {
    std::env::var(name)
        .ok()
        .and_then(|s| s.parse::<u64>().ok())
        .unwrap_or(default)
        .clamp(min, max)
}

fn env_f64_positive(name: &str) -> Option<f64> {
    std::env::var(name)
        .ok()
        .and_then(|s| s.trim().replace(',', ".").parse::<f64>().ok())
        .filter(|v| v.is_finite() && *v > 0.0)
}

fn heartbeat_allocated_vram_mb(gpu_vram_mb: Option<u64>) -> (Option<u64>, Option<u8>) {
    let limit_from_gb = env_f64_positive("VRYX_WORKER_MEMORY_LIMIT_GB")
        .map(|gb| (gb * 1024.0).round() as u64)
        .filter(|mb| *mb > 0);
    let percent = env_f64_positive("VRYX_WORKER_MEMORY_LIMIT_PERCENT")
        .map(|p| p.round().clamp(1.0, 100.0) as u8);
    let limit_from_percent = match (gpu_vram_mb, percent) {
        (Some(vram), Some(pct)) if vram > 0 => Some(((vram as f64) * (pct as f64 / 100.0)).round() as u64),
        _ => None,
    };

    let mut allocated = match (limit_from_gb, limit_from_percent) {
        (Some(a), Some(b)) => Some(a.min(b)),
        (Some(a), None) => Some(a),
        (None, Some(b)) => Some(b),
        (None, None) => gpu_vram_mb,
    };
    if let (Some(vram), Some(value)) = (gpu_vram_mb, allocated) {
        allocated = Some(value.min(vram));
    }
    (allocated.filter(|mb| *mb > 0), percent)
}

mod base64_vec {
    use serde::{Deserialize, Deserializer, Serialize, Serializer};
    use base64::{Engine as _, engine::general_purpose};

    pub fn serialize<S>(bytes: &[u8], serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        general_purpose::STANDARD.encode(bytes).serialize(serializer)
    }

    pub fn deserialize<'de, D>(deserializer: D) -> Result<Vec<u8>, D::Error>
    where
        D: Deserializer<'de>,
    {
        let s = String::deserialize(deserializer)?;
        general_purpose::STANDARD
            .decode(s)
            .map_err(serde::de::Error::custom)
    }
}

#[derive(NetworkBehaviour)]
struct VryxBehaviour {
    mdns: mdns::tokio::Behaviour,
    request_response: request_response::Behaviour<vryx_codec::Codec<TensorRequest, TensorResponse>>,
    kad: kad::Behaviour<kad::store::MemoryStore>,
    identify: identify::Behaviour,
    autonat: autonat::Behaviour,
    relay_client: relay::client::Behaviour,
    relay_server: libp2p::swarm::behaviour::toggle::Toggle<relay::Behaviour>,
    dcutr: dcutr::Behaviour,
}

// ============================================================
//  gRPC (code généré par build.rs)
// ============================================================

pub mod vryx {
    tonic::include_proto!("vryx");
}

use vryx::inference_service_client::InferenceServiceClient;
use tonic::transport::Channel;

async fn connect_local_inference_channel(port: u16) -> Result<Channel, Box<dyn Error + Send + Sync>> {
    // Le serveur Python peut redémarrer pendant le chargement du modèle. Un canal tonic réutilisé
    // garde parfois une socket morte et se traduit par un "transport error" côté P2P.
    let endpoint = Channel::from_shared(format!("http://127.0.0.1:{}", port))?
        .connect_timeout(Duration::from_secs(8))
        .timeout(Duration::from_secs(900))
        .tcp_nodelay(true);
    Ok(endpoint.connect().await?)
}

// ============================================================
//  Persistance du keypair libp2p
// ============================================================

fn load_or_create_keypair(path: &PathBuf) -> Result<libp2p::identity::Keypair, Box<dyn Error>> {
    use libp2p::identity::Keypair;
    if path.exists() {
        let b64 = std::fs::read_to_string(path)?.trim().to_string();
        let bytes = base64::engine::general_purpose::STANDARD.decode(&b64)?;
        let kp = Keypair::from_protobuf_encoding(&bytes)
            .map_err(|e| format!("keypair invalide dans {} : {:?}", path.display(), e))?;
        println!("[*] Keypair chargé depuis {}", path.display());
        Ok(kp)
    } else {
        let kp = Keypair::generate_ed25519();
        let bytes = kp
            .to_protobuf_encoding()
            .map_err(|e| format!("erreur encodage keypair : {:?}", e))?;
        let b64 = base64::engine::general_purpose::STANDARD.encode(&bytes);
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        std::fs::write(path, &b64)?;
        println!("[*] Nouveau keypair généré et sauvegardé dans {}", path.display());
        Ok(kp)
    }
}

#[derive(Debug, Clone, Default)]
struct LlmMetrics {
    prompt_tokens: u64,
    completion_tokens: u64,
    total_tokens: u64,
    vps_delegate_ms: u64,
    shard_session_id: String,
    shard_layer_id: u32,
    pipeline_trace_json: String,
}

fn estimate_chat_token_deltas(data: &[u8]) -> (u64, u64) {
    let text = String::from_utf8_lossy(data);
    let find_number = |key: &str| -> u64 {
        let Some(pos) = text.find(key) else {
            return 0;
        };
        let tail = &text[pos + key.len()..];
        let digits: String = tail
            .chars()
            .skip_while(|c| !c.is_ascii_digit())
            .take_while(|c| c.is_ascii_digit())
            .collect();
        digits.parse::<u64>().unwrap_or(0)
    };
    let Ok(v) = serde_json::from_slice::<serde_json::Value>(data) else {
        return (0, find_number("max_new_tokens").max(find_number("maxNewTokens")));
    };
    let prompt_tokens = v
        .get("prompt")
        .and_then(|x| x.as_str())
        .map(|s| {
            let by_words = s.split_whitespace().count() as u64;
            let by_chars = ((s.chars().count() as u64) / 4).max(1);
            by_words.max(by_chars)
        })
        .unwrap_or(0);
    let completion_tokens = v
        .get("max_new_tokens")
        .or_else(|| v.get("maxNewTokens"))
        .and_then(|x| x.as_u64())
        .unwrap_or(0);
    (prompt_tokens, completion_tokens)
}

fn estimate_text_tokens(data: &[u8]) -> u64 {
    let Ok(text) = std::str::from_utf8(data) else {
        return 0;
    };
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return 0;
    }
    let by_words = trimmed.split_whitespace().count() as u64;
    let by_chars = ((trimmed.chars().count() as u64) / 4).max(1);
    by_words.max(by_chars)
}

fn completion_tokens_from_response_data(data: &[u8]) -> u64 {
    let Ok(v) = serde_json::from_slice::<serde_json::Value>(data) else {
        return 0;
    };
    if v.get("ok").and_then(|x| x.as_bool()) == Some(false) {
        return 0;
    }
    v.get("completion_tokens")
        .or_else(|| v.get("tokens_generated"))
        .or_else(|| v.get("metrics").and_then(|m| m.get("completion_tokens")))
        .or_else(|| v.get("metrics").and_then(|m| m.get("tokens_generated")))
        .and_then(|x| x.as_u64())
        .or_else(|| {
            v.get("token_events")
                .and_then(|x| x.as_array())
                .map(|arr| arr.len() as u64)
        })
        .unwrap_or(0)
}

fn response_data_is_error(data: &[u8]) -> bool {
    serde_json::from_slice::<serde_json::Value>(data)
        .ok()
        .and_then(|v| v.get("ok").and_then(|x| x.as_bool()))
        == Some(false)
}

async fn call_local_inference_once(
    port: u16,
    data: Vec<u8>,
    dtype: String,
    routing_path: Vec<String>,
    session_id: String,
) -> Result<(Vec<u8>, u64, u64, LlmMetrics, u64), Box<dyn Error + Send + Sync>> {
    let channel = connect_local_inference_channel(port).await?;
    let mut client = InferenceServiceClient::new(channel)
        // Aligné avec `inference_server.py` (grpc.aio.server 1 Go) : un init shard / forward
        // peut dépasser 100 Mo (config, métriques, réponses protobuf) sous peine de « transport error » tonic.
        .max_decoding_message_size(1024 * 1024 * 1024)
        .max_encoding_message_size(1024 * 1024 * 1024);

    let response = client
        .process(tonic::Request::new(vryx::TensorData {
            data,
            shape: vec![],
            dtype,
            routing_path,
            session_id,
        }))
        .await?
        .into_inner();
    let mut m = LlmMetrics {
        prompt_tokens: response.prompt_tokens,
        completion_tokens: response.completion_tokens,
        total_tokens: response.total_tokens,
        vps_delegate_ms: response.vps_delegate_ms,
        shard_session_id: response.shard_session_id,
        shard_layer_id: response.shard_layer_id,
        pipeline_trace_json: response.pipeline_trace_json.clone(),
    };
    if (m.prompt_tokens == 0 || m.completion_tokens == 0) && !m.pipeline_trace_json.is_empty() {
        if let Ok(trace) = serde_json::from_str::<serde_json::Value>(&m.pipeline_trace_json) {
            let metrics = trace.get("metrics").unwrap_or(&trace);
            if m.prompt_tokens == 0 {
                m.prompt_tokens = metrics.get("prompt_tokens").and_then(|x| x.as_u64()).unwrap_or(0);
            }
            if m.completion_tokens == 0 {
                m.completion_tokens = metrics
                    .get("completion_tokens")
                    .or_else(|| metrics.get("tokens_generated"))
                    .and_then(|x| x.as_u64())
                    .unwrap_or(0);
            }
            if m.total_tokens == 0 {
                m.total_tokens = metrics.get("total_tokens").and_then(|x| x.as_u64()).unwrap_or(0);
            }
        }
    }
    if m.total_tokens == 0 && (m.prompt_tokens > 0 || m.completion_tokens > 0) {
        m.total_tokens = m.prompt_tokens.saturating_add(m.completion_tokens);
    }
    Ok((
        response.data,
        response.compute_time_ns,
        response.serialization_time_ns,
        m,
        response.compute_time_ms,
    ))
}

/// Après redémarrage du `inference_server.py` local, une première connexion peut tomber pendant
/// le chargement du modèle. On réessaie avec un canal neuf à chaque tentative.
async fn call_local_inference(
    port: u16,
    data: Vec<u8>,
    dtype: String,
    routing_path: Vec<String>,
    session_id: String,
) -> Result<(Vec<u8>, u64, u64, LlmMetrics, u64), Box<dyn Error + Send + Sync>> {
    const MAX_ATTEMPTS: u32 = 4;
    let mut last_msg = String::new();
    for attempt in 0..MAX_ATTEMPTS {
        if attempt > 0 {
            tokio::time::sleep(std::time::Duration::from_millis(200 + u64::from(attempt) * 400)).await;
        }
        match call_local_inference_once(
            port,
            data.clone(),
            dtype.clone(),
            routing_path.clone(),
            session_id.clone(),
        )
        .await
        {
            Ok(v) => return Ok(v),
            Err(e) => {
                let msg = e.to_string();
                let s = msg.to_lowercase();
                let retryable = s.contains("transport")
                    || s.contains("connection refused")
                    || s.contains("tcp connect")
                    || s.contains("broken pipe")
                    || s.contains("cancelled")
                    || s.contains("deadline exceeded")
                    || s.contains("unavailable")
                    || s.contains("connection reset");
                last_msg = msg.clone();
                if retryable && attempt + 1 < MAX_ATTEMPTS {
                    eprintln!(
                        "[!] gRPC local port {} : tentative {} — {}",
                        port,
                        attempt + 1,
                        msg
                    );
                    continue;
                }
                return Err(Box::new(std::io::Error::new(std::io::ErrorKind::Other, msg)));
            }
        }
    }
    Err(Box::new(std::io::Error::new(
        std::io::ErrorKind::Other,
        if last_msg.is_empty() {
            "gRPC local : échec inattendu.".to_string()
        } else {
            last_msg
        },
    )))
}

async fn call_local_inference_stream(
    port: u16,
    data: Vec<u8>,
    dtype: String,
    routing_path: Vec<String>,
    session_id: String,
) -> Result<tonic::Streaming<vryx::StreamChunk>, Box<dyn Error + Send + Sync>> {
    let channel = connect_local_inference_channel(port).await?;
    let mut client = InferenceServiceClient::new(channel)
        .max_decoding_message_size(1024 * 1024 * 1024)
        .max_encoding_message_size(1024 * 1024 * 1024);

    let response = client
        .process_stream(tonic::Request::new(vryx::TensorData {
            data,
            shape: vec![],
            dtype,
            routing_path,
            session_id,
        }))
        .await?;
    Ok(response.into_inner())
}

// ============================================================
//  Heartbeat → API Vryx
// ============================================================

/// Lecture `sysctl -n <key>` (une ligne, sans unité).
fn sysctl_n_trimmed(key: &str) -> Option<String> {
    let out = std::process::Command::new("sysctl")
        .args(["-n", key])
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let s = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if s.is_empty() {
        None
    } else {
        Some(s)
    }
}

/// Mémoire physique (MiB) — utile comme repli VRAM sur Apple Silicon (mémoire unifiée).
fn sysctl_hw_memsize_mib() -> Option<u64> {
    sysctl_n_trimmed("hw.memsize")
        .and_then(|s| s.parse::<u64>().ok())
        .map(|b| b / (1024 * 1024))
}

/// Interprète `spdisplays_vram` ou équivalent (« 16 Go », « 16384 Mo », « 8192 », …) → MiB.
fn parse_vram_human(s: &str) -> Option<u64> {
    let lower = s.to_lowercase();
    let mut buf = String::new();
    for c in s.chars() {
        if c.is_ascii_digit() || c == '.' || c == ',' {
            buf.push(if c == ',' { '.' } else { c });
        } else if !buf.is_empty() {
            break;
        }
    }
    if buf.is_empty() {
        return None;
    }
    let n: f64 = buf.parse().ok()?;
    if lower.contains("gb") || lower.contains("gib") {
        return Some((n * 1024.0).round().max(1.0) as u64);
    }
    if lower.contains("mb") || lower.contains("mib") || lower.contains(" mo") {
        return Some(n.round().max(1.0) as u64);
    }
    // Nombre nu : souvent des MiB côté Apple (ex. 16384 = 16 GiB).
    if n >= 512.0 {
        return Some(n.round() as u64);
    }
    if n >= 4.0 && n <= 256.0 {
        return Some((n * 1024.0).round() as u64);
    }
    None
}

#[cfg(target_os = "macos")]
fn macos_spdisplays_model_is_gpu(name: &str) -> bool {
    let u = name.to_uppercase();
    if u.contains("COLOR LCD") || u == "DISPLAY" {
        return false;
    }
    u.contains("APPLE M")
        || u.contains("AMD")
        || u.contains("RADEON")
        || u.contains("NVIDIA")
        || u.contains("INTEL")
        || u.contains("IRIS")
        || u.contains("UHD")
        || u.contains("ARC ")
        || u.contains("VEGA")
}

#[cfg(target_os = "macos")]
fn macos_gpu_name_rank(name: &str) -> i32 {
    let u = name.to_uppercase();
    if u.contains("APPLE M") {
        100
    } else if u.contains("NVIDIA") || u.contains("RADEON") || u.contains("AMD") {
        80
    } else if u.contains("INTEL") || u.contains("IRIS") || u.contains("UHD") {
        50
    } else {
        10
    }
}

/// macOS : GPU via `system_profiler SPDisplaysDataType -json` (vrai nom puce / carte + VRAM déclarée).
#[cfg(target_os = "macos")]
fn macos_system_profiler_gpu() -> (Option<String>, Option<u64>) {
    let out = match std::process::Command::new("system_profiler")
        .args(["SPDisplaysDataType", "-json"])
        .output()
    {
        Ok(o) if o.status.success() && !o.stdout.is_empty() => o.stdout,
        _ => return (None, None),
    };
    let root: serde_json::Value = match serde_json::from_slice(&out) {
        Ok(v) => v,
        Err(_) => return (None, None),
    };
    let Some(arr) = root.get("SPDisplaysDataType").and_then(|x| x.as_array()) else {
        return (None, None);
    };
    let mut best: Option<(String, Option<u64>, i32)> = None;
    for item in arr {
        let nm = item
            .get("sppci_model")
            .and_then(|x| x.as_str())
            .or_else(|| item.get("chip_model").and_then(|x| x.as_str()))
            .or_else(|| item.get("_name").and_then(|x| x.as_str()))
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty() && macos_spdisplays_model_is_gpu(s));
        let Some(name) = nm else {
            continue;
        };
        let vr = item
            .get("spdisplays_vram")
            .and_then(|x| x.as_str())
            .and_then(parse_vram_human);
        let rank = macos_gpu_name_rank(&name);
        let replace = best
            .as_ref()
            .map(|(_, _, r)| rank > *r || (rank == *r && vr.is_some()))
            .unwrap_or(true);
        if replace {
            best = Some((name, vr, rank));
        }
    }
    match best {
        Some((n, v, _)) => (Some(n), v),
        None => (None, None),
    }
}

#[cfg(target_os = "linux")]
fn linux_nvidia_smi_gpu() -> (Option<String>, Option<u64>) {
    let out = match std::process::Command::new("nvidia-smi")
        .args([
            "--query-gpu=name,memory.total",
            "--format=csv,noheader,nounits",
        ])
        .output()
    {
        Ok(o) if o.status.success() && !o.stdout.is_empty() => o.stdout,
        _ => return (None, None),
    };
    let stdout = String::from_utf8_lossy(&out);
    let Some(line) = stdout.lines().find(|l| !l.trim().is_empty()) else {
        return (None, None);
    };
    let line = line.trim();
    let mut parts = line.split(',').map(|s| s.trim());
    let Some(name) = parts.next().map(str::to_string).filter(|s| !s.is_empty()) else {
        return (None, None);
    };
    let Some(mib) = parts.next().and_then(|s| s.parse::<u64>().ok()).filter(|&n| n > 0) else {
        return (None, None);
    };
    (Some(name), Some(mib))
}

/// Détection matérielle pour le heartbeat (une fois par processus).
fn detect_heartbeat_gpu_hardware() -> (Option<String>, Option<u64>) {
    #[cfg(target_os = "macos")]
    {
        let (prof_n, prof_v) = macos_system_profiler_gpu();
        let name = prof_n.or_else(|| sysctl_n_trimmed("machdep.cpu.brand_string"));
        let vram = prof_v.or_else(sysctl_hw_memsize_mib);
        (name, vram)
    }
    #[cfg(target_os = "linux")]
    {
        linux_nvidia_smi_gpu()
    }
    #[cfg(not(any(target_os = "macos", target_os = "linux")))]
    {
        (None, None)
    }
}

static HEARTBEAT_GPU_HW: OnceLock<(Option<String>, Option<u64>)> = OnceLock::new();

fn heartbeat_gpu_hints_cached() -> (Option<String>, Option<u64>) {
    HEARTBEAT_GPU_HW.get_or_init(detect_heartbeat_gpu_hardware).clone()
}

#[derive(Debug, Serialize)]
struct HeartbeatPayload {
    peer_id: String,
    mode: String,
    grpc_port: Option<u16>,
    p2p_port: Option<u16>,
    version: String,
    user_id: Option<u64>,
    tokens_in: u64,
    tokens_out: u64,
    tokens_generated: u64,
    p2p_peers: usize,
    model: Option<String>,
    /// Absent du JSON si inconnu : évite d’effacer la BDD avec `null` à chaque heartbeat.
    #[serde(skip_serializing_if = "Option::is_none")]
    gpu_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    gpu_vram_mb: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    allocated_vram_mb: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    memory_limit_percent: Option<u8>,
    runtime_backend: Option<String>,
    weight_quantization: Option<String>,
    supports_q4_weights: bool,
    supports_mlx: bool,
    supports_vllm: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    machine_info: Option<serde_json::Value>,
}

async fn send_heartbeat(
    client: &reqwest::Client,
    api_url: &str,
    payload: &HeartbeatPayload,
) {
    let url = format!("{}/api/workers/heartbeat", api_url.trim_end_matches('/'));
    let token = std::env::var("VRYX_WORKER_SECRET")
        .or_else(|_| std::env::var("WORKER_INFERENCE_DELEGATE_SECRET"))
        .unwrap_or_default();
    
    let mut req = client.post(&url).json(payload);
    if !token.is_empty() {
        req = req.header("Authorization", format!("Bearer {}", token));
    }

    match req.send().await {
        Ok(r) if r.status().is_success() => {
            match r.json::<serde_json::Value>().await {
                Ok(body) => {
                    println!("[*] Heartbeat OK → {}", url);
                    if let Some(command) = body.get("command").filter(|c| !c.is_null()) {
                        let event = serde_json::json!({
                            "peer_id": payload.peer_id,
                            "command": command,
                        });
                        println!("[VRYX_REMOTE_COMMAND] {}", event);

                        let action = command
                            .get("action")
                            .and_then(|a| a.as_str())
                            .unwrap_or("")
                            .to_lowercase();
                        let cmd_id = command
                            .get("id")
                            .and_then(|v| v.as_str())
                            .unwrap_or("")
                            .to_string();

                        match action.as_str() {
                            "restart" => {
                                println!(
                                    "[VRYX_REMOTE_COMMAND] Action=restart (cmd={}) → exit(0) pour redémarrage superviseur.",
                                    cmd_id
                                );
                                // Envoyer un ACK avant de quitter pour que la BDD enregistre la livraison
                                let ack_url = format!("{}/api/workers/heartbeat", api_url.trim_end_matches('/'));
                                let ack_payload = serde_json::json!({
                                    "peer_id": payload.peer_id,
                                    "mode": payload.mode,
                                    "command_ack": { "id": cmd_id, "status": "acknowledged" }
                                });
                                let _ = client.post(&ack_url).json(&ack_payload).send().await;
                                std::process::exit(0);
                            }
                            "hot_reload_python" => {
                                // Le payload peut contenir { files: ["shard_runtime", "distributed_llm_orchestrator"] }
                                let files: Vec<String> = command
                                    .get("payload")
                                    .and_then(|p| p.get("files"))
                                    .and_then(|f| f.as_array())
                                    .map(|arr| {
                                        arr.iter()
                                            .filter_map(|v| v.as_str().map(String::from))
                                            .collect()
                                    })
                                    .unwrap_or_default();

                                // Chercher le grpc_port à partir de VRYX_GRPC_PORT ou variable d'environnement
                                let grpc_port_env = std::env::var("VRYX_GRPC_PORT")
                                    .ok()
                                    .and_then(|v| v.parse::<u16>().ok())
                                    .unwrap_or(50052);
                                let admin_port = grpc_port_env + 1;
                                let reload_url = format!("http://127.0.0.1:{}/internal/hot-reload-python", admin_port);
                                let reload_body = serde_json::json!({
                                    "files": files,
                                    "command_id": cmd_id,
                                });
                                println!(
                                    "[VRYX_REMOTE_COMMAND] Action=hot_reload_python (cmd={}) → POST {}",
                                    cmd_id, reload_url
                                );
                                match client.post(&reload_url).json(&reload_body).timeout(
                                    std::time::Duration::from_secs(15)
                                ).send().await {
                                    Ok(resp) => {
                                        let status = resp.status();
                                        let body_text = resp.text().await.unwrap_or_default();
                                        println!("[VRYX_REMOTE_COMMAND] hot_reload_python → HTTP {} : {}", status, body_text);
                                    }
                                    Err(e) => {
                                        eprintln!("[VRYX_REMOTE_COMMAND] hot_reload_python POST échec : {}", e);
                                    }
                                }
                            }
                            _ => {
                                if !action.is_empty() {
                                    println!("[VRYX_REMOTE_COMMAND] Action={} (cmd={}) non gérée côté daemon.", action, cmd_id);
                                }
                            }
                        }
                    }
                }
                Err(_) => println!("[*] Heartbeat OK → {}", url),
            }
        }
        Ok(r) => {
            eprintln!("[!] Heartbeat HTTP {} → {}", r.status(), url);
        }
        Err(e) => {
            eprintln!("[!] Heartbeat erreur : {}", e);
        }
    }
}


/// Initiateur : lit `/api/workers/status`, enregistre les workers et relance un dial relay.
/// Évite la course avec le ticker heartbeat (~30 s) quand `/api/chat` arrive juste après le démarrage.
async fn initiator_pull_workers_from_api_now(
    swarm: &mut Swarm<VryxBehaviour>,
    http_client: &reqwest::Client,
    api_url: &str,
    bootstrap_peer_id: Option<PeerId>,
    bootstrap_node: Option<&String>,
    my_peer_id: PeerId,
    discovered_peers: &mut HashSet<PeerId>,
    active_peers: &Arc<Mutex<HashSet<PeerId>>>,
    registry_worker_count: Option<&Arc<AtomicUsize>>,
    registry_worker_peers: Option<&Arc<Mutex<HashSet<PeerId>>>>,
    log_origin: &'static str,
) {
    let Some(boot_addr_str) = bootstrap_node.map(|s| s.as_str()) else {
        return;
    };
    if boot_addr_str.trim().is_empty() {
        return;
    }
    let url = format!("{}/api/workers/status", api_url.trim_end_matches('/'));
    let fetch = async {
        let resp = http_client.get(&url).send().await.ok()?;
        if !resp.status().is_success() {
            return None;
        }
        resp.json::<serde_json::Value>().await.ok()
    };
    let body = match tokio::time::timeout(Duration::from_secs(4), fetch).await {
        Ok(Some(json)) => json,
        Ok(None) => {
            if log_origin == "chat" {
                eprintln!(
                    "[P2P] Pré-chat : HTTP invalide ou JSON pour {}",
                    url
                );
            }
            return;
        }
        Err(_) => {
            if log_origin == "chat" {
                eprintln!("[P2P] Pré-chat : dépassement 4 s sur {}", url);
            }
            return;
        }
    };
    let workers = match body.get("workers").and_then(|v| v.as_array()) {
        Some(w) => w,
        None => return,
    };
    let mut registry_count = 0usize;
    let mut registry_peers = HashSet::<PeerId>::new();
    for worker in workers {
        if worker.get("mode").and_then(|v| v.as_str()) != Some("worker") {
            continue;
        }
        let Some(peer_str) = worker.get("peerId").and_then(|v| v.as_str()) else {
            continue;
        };
        if peer_str == my_peer_id.to_string() {
            continue;
        }
        let Ok(peer_id) = peer_str.parse::<PeerId>() else {
            continue;
        };
        if Some(peer_id) == bootstrap_peer_id {
            continue;
        }
        registry_count += 1;
        registry_peers.insert(peer_id);
        let relay_addr_str = format!("{}/p2p-circuit/p2p/{}", boot_addr_str, peer_id);
        let Ok(relay_addr) = relay_addr_str.parse::<Multiaddr>() else {
            continue;
        };
        swarm.behaviour_mut().kad.add_address(&peer_id, relay_addr.clone());
        swarm.add_peer_address(peer_id, relay_addr.clone());
        let newly_discovered = discovered_peers.insert(peer_id);
        if newly_discovered {
            match log_origin {
                "heartbeat" => println!("[P2P] Worker heartbeat ajouté : {}", peer_id),
                _ => println!("[P2P] Pré-chat : worker depuis API : {}", peer_id),
            }
        }
        if !active_peers.lock().unwrap().contains(&peer_id) {
            if let Err(e) = swarm.dial(relay_addr) {
                eprintln!(
                    "[!] Dial worker {} échoué ({:?})",
                    peer_id, e
                );
            } else {
                match log_origin {
                    "heartbeat" => println!("[P2P] Dial worker heartbeat : {}", peer_id),
                    _ => println!("[P2P] Pré-chat : dial relay vers {}", peer_id),
                }
            }
        }
    }
    if let Some(atom) = registry_worker_count {
        atom.store(registry_count, Ordering::Relaxed);
    }
    if let Some(peers) = registry_worker_peers {
        *peers.lock().unwrap() = registry_peers;
    }
}

// ============================================================
//  main
// ============================================================

#[tokio::main]
async fn main() -> Result<(), Box<dyn Error>> {
    let args = Args::parse();

    // Filtre de log : on coupe le spam yamux/noise/autonat sauf si RUST_LOG est positionné.
    if std::env::var("RUST_LOG").is_err() {
        std::env::set_var(
            "RUST_LOG",
            "info,yamux=error,libp2p_yamux=error,\
             libp2p_noise=error,libp2p_autonat=error,\
             libp2p_relay=error,libp2p_dcutr=error,\
             libp2p_mdns=error,libp2p_kad=error,libp2p_identify=error",
        );
    }
    tracing_subscriber::fmt()
        .with_env_filter(tracing_subscriber::EnvFilter::from_default_env())
        .init();

    // ── Keypair (persistant si --node-key-file fourni) ──────────────────────
    let keypair = if let Some(ref path) = args.node_key_file {
        load_or_create_keypair(path)?
    } else {
        libp2p::identity::Keypair::generate_ed25519()
    };

    // ── Swarm ──────────────────────────────────────────────────────────────
    let mut swarm = libp2p::SwarmBuilder::with_existing_identity(keypair)
        .with_tokio()
        .with_tcp(
            tcp::Config::default(),
            noise::Config::new,
            || {
                let mut config = yamux::Config::default();
                config.set_receive_window_size(10 * 1024 * 1024);
                config
            }
        )?
        .with_quic()
        .with_dns()?
        .with_relay_client(
            noise::Config::new,
            || {
                let mut config = yamux::Config::default();
                config.set_receive_window_size(10 * 1024 * 1024);
                config
            }
        )?
        .with_behaviour(|key, relay_behaviour| {
            let peer_id = key.public().to_peer_id();
            let mdns = mdns::tokio::Behaviour::new(mdns::Config::default(), peer_id)?;
            let mut rr_config = request_response::Config::default();
            let p2p_request_timeout_s = env_u64_clamped("VRYX_P2P_REQUEST_TIMEOUT_S", 3600, 30, 7200);
            rr_config.set_request_timeout(Duration::from_secs(p2p_request_timeout_s));
            // Codec personnalisé 512 MB pour le transfert de tranches de poids LLM.
            let request_response = request_response::Behaviour::with_codec(
                vryx_codec::Codec::<TensorRequest, TensorResponse>::default(),
                [(StreamProtocol::new("/vryx/tensor/1.0.0"), ProtocolSupport::Full)],
                rr_config,
            );
            let store = kad::store::MemoryStore::new(peer_id);
            let mut kad = kad::Behaviour::new(peer_id, store);
            if args.mode == "bootstrap" {
                kad.set_mode(Some(kad::Mode::Server));
            }
            let identify = identify::Behaviour::new(
                identify::Config::new("/vryx/1.0.0".into(), key.public()),
            );
            let autonat = autonat::Behaviour::new(peer_id, autonat::Config::default());
            let dcutr = dcutr::Behaviour::new(peer_id);
            let relay_server = if args.mode == "bootstrap" {
                let mut config = libp2p::relay::Config::default();
                config.reservation_duration = Duration::from_secs(3600);
                config.max_reservations = 1000;
                config.max_circuits = 1000;
                config.max_circuit_duration = Duration::from_secs(3600);
                config.max_circuit_bytes = 1024 * 1024 * 1024; // 1 GB
                // Désactivation des rate limiters pour debug
                config.reservation_rate_limiters = vec![];
                config.circuit_src_rate_limiters = vec![];
                Some(libp2p::relay::Behaviour::new(peer_id, config))
            } else {
                None
            }.into();

            Ok(VryxBehaviour {
                mdns,
                request_response,
                kad,
                identify,
                autonat,
                relay_client: relay_behaviour,
                relay_server,
                dcutr,
            })
        })?
        .with_swarm_config(|c| {
            let idle_timeout_s = env_u64_clamped("VRYX_P2P_IDLE_TIMEOUT_S", 900, 30, 7200);
            c.with_idle_connection_timeout(Duration::from_secs(idle_timeout_s))
        })
        .build();

    swarm.listen_on(format!("/ip4/0.0.0.0/tcp/{}", args.p2p_port).parse()?)?;
    swarm.listen_on(format!("/ip4/0.0.0.0/udp/{}/quic-v1", args.p2p_port).parse()?)?;
    if args.mode == "bootstrap" {
        swarm.add_external_address(format!("/ip4/51.222.26.225/tcp/{}", args.p2p_port).parse()?);
        swarm.add_external_address(format!("/ip4/51.222.26.225/udp/{}/quic-v1", args.p2p_port).parse()?);
    }

    let my_peer_id = *swarm.local_peer_id();
    println!(
        "\n╔══════════════════════════════════════════════╗"
    );
    println!("║  Vryx Node  │  mode = {}  ", args.mode);
    println!("║  PeerId : {}", my_peer_id);
    println!(
        "╚══════════════════════════════════════════════╝\n"
    );

    // ── Bootstrap node ────────────────────────────────────────────────────
    let mut bootstrap_peer_id: Option<PeerId> = None;
    if let Some(boot_addr_str) = &args.bootstrap_node {
        let addr: Multiaddr = boot_addr_str.parse().map_err(|e| {
            format!(
                "Multiaddr invalide pour --bootstrap-node : {}\n\
                 Format attendu : /ip4/<IP>/tcp/<PORT>/p2p/<PEER_ID>",
                e
            )
        })?;
        if let Some(libp2p::multiaddr::Protocol::P2p(pid)) = addr.iter().last() {
            bootstrap_peer_id = Some(pid);
            swarm.behaviour_mut().kad.add_address(&pid, addr.clone());
            let _ = swarm.behaviour_mut().kad.bootstrap();
            println!("[*] Bootstrap node : {}", boot_addr_str);
            println!("[*] Kademlia bootstrap lancé…\n");
        } else {
            eprintln!(
                "[!] L'adresse bootstrap ne contient pas de PeerId (/p2p/…). \
                 Vérifiez le paramètre --bootstrap-node."
            );
        }

        // On attend d'être connecté au bootstrap pour lancer l'écoute relay
    }

    // ── État ──────────────────────────────────────────────────────────────
    let mut discovered_peers: HashSet<PeerId> = HashSet::new();

    #[derive(Debug)]
    enum PendingMeta {
        P2pRelayReply {
            reply_tx: tokio::sync::oneshot::Sender<std::result::Result<TensorResponse, String>>,
            relay_started: Instant,
            hidden_bytes: u64,
            persistent_relay: bool,
            connection_reuse: bool,
        },
        Forwarded { original_channel: request_response::ResponseChannel<TensorResponse> },
    }

    let mut pending_requests: HashMap<
        request_response::OutboundRequestId,
        (TensorRequest, PendingMeta),
    > = HashMap::new();
    // Requêtes POST /api/p2p/relay avant qu'une première connexion libp2p existe : send_request trop tôt → DialFailure libp2p.
    let mut pending_relay_until_connected: HashMap<
        PeerId,
        VecDeque<(
            TensorRequest,
            tokio::sync::oneshot::Sender<std::result::Result<TensorResponse, String>>,
            Instant,
        )>,
    > = HashMap::new();

    type ChatApiTx = tokio::sync::oneshot::Sender<serde_json::Value>;

    #[derive(Debug)]
    enum ChatState {
        Idle,
        Generating {
            response_tx: Option<ChatApiTx>,
            request_started: Instant,
        },
    }
    let mut chat_state = ChatState::Idle;
    // Requêtes `/api/chat` reçues pendant une génération en cours (évite « inférence encore en cours »).
    let mut chat_pending: VecDeque<(String, Option<ChatApiTx>)> = VecDeque::new();
    let chat_queue_max: usize = std::env::var("VRYX_CHAT_QUEUE_MAX")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(64usize)
        .clamp(1, 256);
    let hidden_quic_requested = std::env::var("VRYX_HIDDEN_QUIC")
        .map(|v| matches!(v.to_lowercase().as_str(), "1" | "true" | "yes"))
        .unwrap_or(false);

    // ── Shared State (pour l'API Axum) ────────────────────────────────────
    let active_peers = Arc::new(Mutex::new(HashSet::<PeerId>::new()));
    let peer_transports = Arc::new(Mutex::new(HashMap::<PeerId, String>::new()));
    // Compteur par pair : plusieurs connexions simultanées (QUIC + relay, etc.) sont courantes ;
    // ne pas retirer le pair de `active_peers` à la fermeture d'un seul canal.
    let peer_connection_count = Arc::new(Mutex::new(HashMap::<PeerId, u32>::new()));
    // Dernier nombre de workers mode « worker » vus via GET /api/workers/status (aligné sur la base / heartbeat).
    let initiator_registry_workers = Arc::new(AtomicUsize::new(0));
    let initiator_registry_worker_peers = Arc::new(Mutex::new(HashSet::<PeerId>::new()));
    let tokens_in = Arc::new(AtomicU64::new(0));
    let tokens_out = Arc::new(AtomicU64::new(0));
    let tokens_generated = Arc::new(AtomicU64::new(0));
    let last_shard_trace = Arc::new(Mutex::new(Option::<serde_json::Value>::None));

    // Channel pour envoyer des commandes chat via l'API (initiator seulement)
    // (Prompt, Response Sender)
    let (cmd_tx, mut cmd_rx) = tokio::sync::mpsc::unbounded_channel::<(String, Option<ChatApiTx>)>();
    let (p2p_relay_tx, mut p2p_relay_rx) = tokio::sync::mpsc::unbounded_channel::<(
        PeerId,
        TensorRequest,
        tokio::sync::oneshot::Sender<std::result::Result<TensorResponse, String>>,
    )>();

    let boot_for_tp_api = bootstrap_peer_id;

    // ── Lancement de l'API Axum (Dashboard local) ─────────────────────────
    {
        let active_peers = Arc::clone(&active_peers);
        let tokens_in = Arc::clone(&tokens_in);
        let tokens_out = Arc::clone(&tokens_out);
        let tokens_generated = Arc::clone(&tokens_generated);
        let last_shard_trace_axum = Arc::clone(&last_shard_trace);
        let my_peer_id_str = my_peer_id.to_string();
        let cmd_tx_axum = cmd_tx.clone();
        let p2p_relay_axum = p2p_relay_tx.clone();
        let mode_chat = args.mode.clone();
        let mode_chat_stream = args.mode.clone();
        let mode_relay = args.mode.clone();
        let mode_status_diag = args.mode.clone();
        let mode_tp_diag = args.mode.clone();
        let grpc_axum_health = args.grpc_port;
        let grpc_chat_stream = args.grpc_port;
        let api_axum_port = args.api_port;
        let active_status_peers = Arc::clone(&active_peers);
        let active_relay_peers = Arc::clone(&active_peers);
        let active_tp_peers = Arc::clone(&active_peers);
        let registry_tp_peers = Arc::clone(&initiator_registry_worker_peers);
        let status_peer_transports = Arc::clone(&peer_transports);
        let grpc_shard_status = args.grpc_port;
        let relay_peer_transports = Arc::clone(&peer_transports);
        let quic_requested_status = hidden_quic_requested;
        let registry_status_peers = Arc::clone(&initiator_registry_workers);

        let app = Router::new()
            .route("/api/status", get(move || {
                let connections = active_status_peers.lock().unwrap().len();
                let t_in = tokens_in.load(Ordering::Relaxed);
                let t_out = tokens_out.load(Ordering::Relaxed);
                let t_gen = tokens_generated.load(Ordering::Relaxed);
                let shard = last_shard_trace_axum.lock().unwrap().clone();
                let transport_snapshot = status_peer_transports.lock().unwrap().clone();
                let active_orch_snap = Arc::clone(&active_status_peers);
                let mode_s = mode_status_diag.clone();
                let boot_id = boot_for_tp_api;
                let me_id = my_peer_id;
                let grpc_s = grpc_axum_health;
                let api_s = api_axum_port;
                async move {
                    let mut j = serde_json::json!({
                        "peer_id": my_peer_id_str,
                        "daemon_mode": mode_s,
                        "active_connections": connections,
                        "tokens_in": t_in,
                        "tokens_out": t_out,
                        "tokens_generated": t_gen,
                        "quic_requested": quic_requested_status,
                        "quic_available": true,
                        "quic_used": quic_requested_status,
                        "quic_fallback": if quic_requested_status { "native_quic_enabled" } else { "disabled" },
                        "connection_transports": transport_snapshot.iter().map(|(p, t)| (p.to_string(), t.clone())).collect::<HashMap<String, String>>(),
                    });
                    if let Some(obj) = j.as_object_mut() {
                        obj.insert("last_shard_trace".into(), shard.unwrap_or(serde_json::Value::Null));
                        if mode_s == "initiator" {
                            let n_live = {
                                let snap = active_orch_snap.lock().unwrap();
                                snap.iter()
                                    .copied()
                                    .filter(|&pid| {
                                        boot_id.map(|b| b != pid).unwrap_or(true) && pid != me_id
                                    })
                                    .count()
                            };
                            let n_reg = registry_status_peers.load(Ordering::Relaxed);
                            // Les dials relay peuvent rester sans « Connexion établie » immédiate alors que les workers sont bien listés dans l’API (heartbeat).
                            let n_workers = n_live.max(n_reg);
                            obj.insert(
                                "orchestrator_health".into(),
                                serde_json::json!({
                                    "ok": true,
                                    "grpc_stage1_port": grpc_s,
                                    "axum_api_port": api_s,
                                    "workers_connected_p2p": n_live,
                                    "workers_visible_p2p": n_workers,
                                }),
                            );
                        }
                    }
                    Json(j)
                }
            }))
            .route("/api/shards", get(move || {
                let grpc_port = grpc_shard_status;
                async move {
                    let call = call_local_inference_once(
                        grpc_port,
                        b"{}".to_vec(),
                        "vryx.shard.status".to_string(),
                        vec![],
                        String::new(),
                    );
                    match tokio::time::timeout(Duration::from_millis(1500), call).await {
                        Ok(Ok((data, _, _, _, _))) => {
                            let body = serde_json::from_slice::<serde_json::Value>(&data)
                                .unwrap_or_else(|_| serde_json::json!({
                                    "ok": false,
                                    "error": String::from_utf8_lossy(&data).to_string(),
                                }));
                            (StatusCode::OK, Json(body))
                        }
                        Ok(Err(e)) => (
                            StatusCode::SERVICE_UNAVAILABLE,
                            Json(serde_json::json!({
                                "ok": false,
                                "error": e.to_string(),
                            })),
                        ),
                        Err(_) => (
                            StatusCode::GATEWAY_TIMEOUT,
                            Json(serde_json::json!({
                                "ok": false,
                                "error": "shard_status_timeout",
                            })),
                        ),
                    }
                }
            }))
            .route(
                "/api/tp-peers",
                get({
                    let active = Arc::clone(&active_tp_peers);
                    let mode = mode_tp_diag.clone();
                    let boot = boot_for_tp_api;
                    let me = my_peer_id;
                    move || async move {
                        if mode != "initiator" {
                            return (
                                StatusCode::FORBIDDEN,
                                Json(serde_json::json!({
                                    "ok": false,
                                    "peers": serde_json::Value::Array(vec![]),
                                    "count": 0,
                                    "error": "Réservé au mode initiateur.",
                                })),
                            );
                        }
                        let mut ids: Vec<String> = active
                            .lock()
                            .unwrap()
                            .iter()
                            .copied()
                            .filter(|p| Some(*p) != boot && *p != me)
                            .map(|p| p.to_string())
                            .collect();
                        ids.extend(
                            registry_tp_peers
                                .lock()
                                .unwrap()
                                .iter()
                                .copied()
                                .filter(|p| Some(*p) != boot && *p != me)
                                .map(|p| p.to_string()),
                        );
                        ids.sort();
                        ids.dedup();
                        let n = ids.len();
                        (
                            StatusCode::OK,
                            Json(serde_json::json!({
                                "ok": true,
                                "peers": ids,
                                "count": n,
                                "layout_hint": "pipeline_relay_daisy_chain",
                            })),
                        )
                    }
                }),
            )
            .route("/api/chat", post(move |Json(payload): Json<serde_json::Value>| async move {
                if mode_chat != "initiator" {
                    return (axum::http::StatusCode::FORBIDDEN, Json(serde_json::json!({"error": "Node not in initiator mode"})));
                }
                if let Some(prompt) = payload["prompt"].as_str() {
                    let quantization = payload
                        .get("quantization")
                        .or_else(|| payload.get("hidden_transport"))
                        .and_then(|v| v.as_str())
                        .filter(|v| matches!(*v, "q4" | "int8" | "fp16"))
                        .unwrap_or("int8");
                    let pool_preference = payload
                        .get("pool_preference")
                        .and_then(|v| v.as_str())
                        .filter(|v| matches!(*v, "auto" | "velocity_mlx" | "velocity_vllm" | "legacy_pytorch"))
                        .unwrap_or("auto");
                    let mut request_obj = serde_json::json!({
                        "prompt": prompt,
                        "quantization": quantization,
                        "hidden_transport": quantization,
                        "pool_preference": pool_preference,
                    });
                    if let Some(mt) =
                        payload
                            .get("max_new_tokens")
                            .and_then(|v| {
                                v.as_u64().or_else(|| {
                                    v.as_i64().and_then(|i| {
                                        if i >= 1 { Some(i as u64) } else { None }
                                    })
                                })
                            })
                            .filter(|&mt| mt >= 1 && mt <= 32768)
                    {
                        request_obj["max_new_tokens"] = serde_json::json!(mt);
                    }
                    if let Some(model_id) = payload
                        .get("model_id")
                        .or_else(|| payload.get("modelId"))
                        .and_then(|v| v.as_str())
                        .map(|s| s.trim())
                        .filter(|s| !s.is_empty() && s.len() <= 120)
                    {
                        request_obj["model_id"] = serde_json::json!(model_id);
                    }
                    if let Some(preferred_workers) = payload
                        .get("preferred_worker_peer_ids")
                        .or_else(|| payload.get("preferredWorkerPeerIds"))
                        .filter(|v| v.is_array())
                    {
                        request_obj["preferred_worker_peer_ids"] = preferred_workers.clone();
                    }
                    if let Some(scheduler_job_id) = payload
                        .get("scheduler_job_id")
                        .or_else(|| payload.get("schedulerJobId"))
                        .and_then(|v| v.as_str())
                        .map(|s| s.trim())
                        .filter(|s| !s.is_empty() && s.len() <= 100)
                    {
                        request_obj["scheduler_job_id"] = serde_json::json!(scheduler_job_id);
                    }
                    for key in ["stream_id", "stream_secret", "stream_callback_url"] {
                        if let Some(value) = payload.get(key).and_then(|v| v.as_str()).filter(|s| !s.is_empty()) {
                            request_obj[key] = serde_json::json!(value);
                        }
                    }
                    for key in ["temperature", "top_p", "top_k", "repetition_penalty"] {
                        if let Some(value) = payload.get(key) {
                            if value.is_number() {
                                request_obj[key] = value.clone();
                            }
                        }
                    }
                    let request_payload = request_obj.to_string();
                    let (tx, rx) = tokio::sync::oneshot::channel();
                    let _ = cmd_tx_axum.send((request_payload, Some(tx)));
                    
                    match tokio::time::timeout(std::time::Duration::from_secs(3600), rx).await {
                        Ok(Ok(response)) => {
                            if response.get("ok").and_then(|v| v.as_bool()) == Some(false) {
                                (axum::http::StatusCode::BAD_REQUEST, Json(response))
                            } else {
                                (axum::http::StatusCode::OK, Json(response))
                            }
                        }
                        Ok(Err(_)) => (
                            axum::http::StatusCode::INTERNAL_SERVER_ERROR,
                            Json(serde_json::json!({"ok": false, "error": "Canal de réponse fermé"})),
                        ),
                        Err(_) => (
                            axum::http::StatusCode::GATEWAY_TIMEOUT,
                            Json(serde_json::json!({"ok": false, "error": "Délai d'inférence dépassé"})),
                        ),
                    }
                } else {
                    (axum::http::StatusCode::BAD_REQUEST, Json(serde_json::json!({"error": "Missing prompt"})))
                }
            }))
            .route("/api/chat/stream", post(move |Json(payload): Json<serde_json::Value>| async move {
                if mode_chat_stream != "initiator" {
                    return Response::builder()
                        .status(StatusCode::FORBIDDEN)
                        .header("content-type", "application/x-ndjson; charset=utf-8")
                        .body(Body::from("{\"event\":\"error\",\"error\":\"Node not in initiator mode\",\"done\":true}\n"))
                        .unwrap();
                }
                let Some(prompt) = payload["prompt"].as_str() else {
                    return Response::builder()
                        .status(StatusCode::BAD_REQUEST)
                        .header("content-type", "application/x-ndjson; charset=utf-8")
                        .body(Body::from("{\"event\":\"error\",\"error\":\"Missing prompt\",\"done\":true}\n"))
                        .unwrap();
                };
                let quantization = payload
                    .get("quantization")
                    .or_else(|| payload.get("hidden_transport"))
                    .and_then(|v| v.as_str())
                    .filter(|v| matches!(*v, "q4" | "int8" | "fp16"))
                    .unwrap_or("int8");
                let pool_preference = payload
                    .get("pool_preference")
                    .and_then(|v| v.as_str())
                    .filter(|v| matches!(*v, "auto" | "velocity_mlx" | "velocity_vllm" | "legacy_pytorch"))
                    .unwrap_or("auto");
                let mut request_obj = serde_json::json!({
                    "prompt": prompt,
                    "quantization": quantization,
                    "hidden_transport": quantization,
                    "pool_preference": pool_preference,
                });
                if let Some(mt) = payload
                    .get("max_new_tokens")
                    .and_then(|v| v.as_u64().or_else(|| v.as_i64().and_then(|i| if i >= 1 { Some(i as u64) } else { None })))
                    .filter(|&mt| mt >= 1 && mt <= 32768)
                {
                    request_obj["max_new_tokens"] = serde_json::json!(mt);
                }
                if let Some(model_id) = payload
                    .get("model_id")
                    .or_else(|| payload.get("modelId"))
                    .and_then(|v| v.as_str())
                    .map(|s| s.trim())
                    .filter(|s| !s.is_empty() && s.len() <= 120)
                {
                    request_obj["model_id"] = serde_json::json!(model_id);
                }
                if let Some(preferred_workers) = payload
                    .get("preferred_worker_peer_ids")
                    .or_else(|| payload.get("preferredWorkerPeerIds"))
                    .filter(|v| v.is_array())
                {
                    request_obj["preferred_worker_peer_ids"] = preferred_workers.clone();
                }
                if let Some(scheduler_job_id) = payload
                    .get("scheduler_job_id")
                    .or_else(|| payload.get("schedulerJobId"))
                    .and_then(|v| v.as_str())
                    .map(|s| s.trim())
                    .filter(|s| !s.is_empty() && s.len() <= 100)
                {
                    request_obj["scheduler_job_id"] = serde_json::json!(scheduler_job_id);
                }
                for key in ["stream_id", "stream_secret", "stream_callback_url"] {
                    if let Some(value) = payload.get(key).and_then(|v| v.as_str()).filter(|s| !s.is_empty()) {
                        request_obj[key] = serde_json::json!(value);
                    }
                }
                for key in ["temperature", "top_p", "top_k", "repetition_penalty"] {
                    if let Some(value) = payload.get(key) {
                        if value.is_number() {
                            request_obj[key] = value.clone();
                        }
                    }
                }
                match call_local_inference_stream(
                    grpc_chat_stream,
                    request_obj.to_string().into_bytes(),
                    "text".to_string(),
                    vec![],
                    String::new(),
                ).await {
                    Ok(stream) => {
                        let mapped = stream.map(|item| {
                            let value = match item {
                                Ok(chunk) => serde_json::json!({
                                    "event": chunk.event,
                                    "token": chunk.token,
                                    "json": chunk.json,
                                    "done": chunk.done,
                                    "error": chunk.error,
                                    "elapsed_ms": chunk.elapsed_ms,
                                }),
                                Err(err) => serde_json::json!({
                                    "event": "error",
                                    "error": err.to_string(),
                                    "done": true,
                                }),
                            };
                            Ok::<Bytes, std::convert::Infallible>(Bytes::from(format!("{}\n", value)))
                        });
                        Response::builder()
                            .status(StatusCode::OK)
                            .header("content-type", "application/x-ndjson; charset=utf-8")
                            .header("cache-control", "no-cache")
                            .body(Body::from_stream(mapped))
                            .unwrap()
                    }
                    Err(err) => Response::builder()
                        .status(StatusCode::BAD_GATEWAY)
                        .header("content-type", "application/x-ndjson; charset=utf-8")
                        .body(Body::from(format!(
                            "{}\n",
                            serde_json::json!({"event":"error","error":err.to_string(),"done":true})
                        )))
                        .unwrap(),
                }
            }))
            .route("/api/p2p/relay", post(move |Json(payload): Json<serde_json::Value>| async move {
                use base64::{Engine as _, engine::general_purpose};
                if mode_relay != "initiator" {
                    return (
                        axum::http::StatusCode::FORBIDDEN,
                        Json(serde_json::json!({"ok": false, "error": "Relais P2P : mode initiateur requis."})),
                    );
                }
                let peer_str = payload.get("target_peer").and_then(|v| v.as_str()).unwrap_or("");
                let peer: PeerId = match PeerId::from_str(peer_str) {
                    Ok(p) => p,
                    Err(_) => {
                        return (
                            axum::http::StatusCode::BAD_REQUEST,
                            Json(serde_json::json!({"ok": false, "error": "target_peer libp2p invalide."})),
                        );
                    }
                };
                let dtype = payload
                    .get("dtype")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string();
                let data_b64 = payload.get("data_b64").and_then(|v| v.as_str()).unwrap_or("");
                let data = match general_purpose::STANDARD.decode(data_b64) {
                    Ok(d) => d,
                    Err(e) => {
                        return (
                            axum::http::StatusCode::BAD_REQUEST,
                            Json(serde_json::json!({"ok": false, "error": format!("data_b64 : {}", e)})),
                        );
                    }
                };
                let session_id = payload.get("session_id").and_then(|v| v.as_str()).unwrap_or("").to_string();
                let persistent_relay = payload
                    .get("persistent_relay")
                    .and_then(|v| v.as_bool())
                    .unwrap_or(true);
                let routing_path = payload.get("routing_path").and_then(|v| v.as_array()).map(|arr| {
                    arr.iter().filter_map(|v| v.as_str().map(|s| s.to_string())).collect()
                }).unwrap_or_default();
                
                let req = TensorRequest {
                    kind: String::new(),
                    data,
                    dtype,
                    compute_time_ns: 0,
                    serialization_time_ns: 0,
                    routing_path,
                    session_id,
                };
                let (tx, rx) = tokio::sync::oneshot::channel();
                let connection_reuse = active_relay_peers.lock().unwrap().contains(&peer);
                let connection_transport = relay_peer_transports
                    .lock()
                    .unwrap()
                    .get(&peer)
                    .cloned()
                    .unwrap_or_else(|| "unknown".to_string());
                let relay_quic_used = connection_transport.contains("/quic");
                if p2p_relay_axum.send((peer, req, tx)).is_err() {
                    return (
                        axum::http::StatusCode::SERVICE_UNAVAILABLE,
                        Json(serde_json::json!({"ok": false, "error": "Canal relais indisponible."})),
                    );
                }
                match tokio::time::timeout(std::time::Duration::from_secs(3600), rx).await {
                    Ok(Ok(Ok(resp))) => {
                        let data_b64 = general_purpose::STANDARD.encode(&resp.data);
                        (
                            axum::http::StatusCode::OK,
                            Json(serde_json::json!({
                                "ok": true,
                                "data_b64": data_b64,
                                "relay_ms": resp.vps_delegate_ms,
                                "serialization_ms": resp.serialization_time_ns / 1_000_000,
                                "hidden_bytes": resp.p2p_messages_in,
                                "persistent_relay": persistent_relay,
                                "connection_reuse": connection_reuse,
                                "connection_transport": connection_transport,
                                "quic_available": true,
                                "quic_used": relay_quic_used,
                                "prompt_tokens": resp.prompt_tokens_llm,
                                "completion_tokens": resp.completion_tokens_llm,
                                "total_tokens": resp.total_tokens_llm,
                                "vps_delegate_ms": resp.vps_delegate_ms,
                                "worker_compute_ms": resp.worker_compute_ms,
                                "compute_time_ms": resp.compute_time_ms.max(resp.worker_compute_ms),
                                "shard_session_id": resp.shard_session_id,
                            })),
                        )
                    }
                    Ok(Ok(Err(e))) => (
                        axum::http::StatusCode::BAD_GATEWAY,
                        Json(serde_json::json!({"ok": false, "error": e})),
                    ),
                    Ok(Err(_)) => (
                        axum::http::StatusCode::INTERNAL_SERVER_ERROR,
                        Json(serde_json::json!({"ok": false, "error": "Réponse relais annulée."})),
                    ),
                    Err(_) => (
                        axum::http::StatusCode::GATEWAY_TIMEOUT,
                        Json(serde_json::json!({"ok": false, "error": "Délai relais P2P dépassé."})),
                    ),
                }
            }))
            .layer(DefaultBodyLimit::max(512 * 1024 * 1024)) // 512 MB pour les poids de modèle
            .layer(CorsLayer::permissive());

        let api_port = args.api_port;
        tokio::spawn(async move {
            let addr = format!("127.0.0.1:{}", api_port);
            println!("[*] API Dashboard locale sur http://{}", addr);
            let listener = tokio::net::TcpListener::bind(addr).await.unwrap();
            axum::serve(listener, app).await.unwrap();
        });
    }

    if args.mode == "initiator" {
        println!("[Vryx Chat] Tapez votre message et appuyez sur Entrée.");
        println!("[Vryx Chat] Attendez qu'un worker soit découvert avant d'écrire.");
        print!("> Vous : ");
        tokio::io::stdout().flush().await?;
    }

    // ── Timers ────────────────────────────────────────────────────────────
    let mut bootstrap_interval = time::interval(Duration::from_secs(30));
    bootstrap_interval.set_missed_tick_behavior(time::MissedTickBehavior::Skip);

    let mut heartbeat_interval = time::interval(Duration::from_secs(30));
    heartbeat_interval.set_missed_tick_behavior(time::MissedTickBehavior::Skip);

    let model_name = args.model.clone();

    // Client HTTP (heartbeat + découverte initiateur)
    let http_client = reqwest::Client::builder()
        .timeout(Duration::from_secs(10))
        .build()
        .unwrap_or_default();

    // Channel pour les résultats d'inférence (évite de bloquer la boucle swarm)
    enum InferenceResult {
        Stage1 {
            peer_id: PeerId,
            data: Vec<u8>,
            c: u64,
            s: u64,
            /// `Some` = requête HTTP initiale ; conservé pour garder le canal de réponse.
            continuation_response_tx: Option<ChatApiTx>,
            request_started: Instant,
            pipeline_trace_json: String,
            compute_time_ms: u64,
        },
        Stage2 {
            channel: request_response::ResponseChannel<TensorResponse>,
            data: Vec<u8>,
            c: u64,
            s: u64,
            metrics: LlmMetrics,
            compute_time_ms: u64,
        },
        Stage2Error {
            channel: request_response::ResponseChannel<TensorResponse>,
            message: String,
        },
        PipelineForward {
            target_peer: PeerId,
            request: TensorRequest,
            original_channel: request_response::ResponseChannel<TensorResponse>,
        },
        Error { 
            context: String, 
            message: String 
        },
    }
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<InferenceResult>();

    // Démarre Stage 1 (orchestrateur local) vers le premier worker actif. Retourne `true` si un job a été lancé.
    macro_rules! try_start_chat_inference {
        ($prompt_line:expr, $resp_tx:expr) => {{
            let prompt_line = $prompt_line;
            let mut resp_opt = $resp_tx;
            let active_snapshot = active_peers.lock().unwrap().clone();
            // Préférer un worker à la fois dans la DHT/API et connecté ; sinon secours : worker seulement
            // « découvert » (p.ex. une connexion relay vient de retomber alors que le heartbeat API est encore bon).
            let worker = {
                let mut cand: Vec<PeerId> = discovered_peers
                    .iter()
                    .copied()
                    .filter(|p| !bootstrap_peer_id.is_some_and(|b| b == *p))
                    .collect();
                cand.sort_by_key(|p| p.to_string());
                cand.iter()
                    .find(|p| active_snapshot.contains(p))
                    .copied()
                    .or_else(|| cand.first().copied())
            };
            if let Some(peer) = worker {
                if !active_snapshot.contains(&peer) {
                    eprintln!(
                        "[P2P] Chat : secours (worker connu via API / dial, pas encore dans active_peers) → {}",
                        peer
                    );
                }
                let prompt = prompt_line.clone();
                print!("> Assistant : ");
                let _ = tokio::io::stdout().flush().await;
                let request_started = Instant::now();
                let tx_stage1 = tx.clone();
                let grpc_port = args.grpc_port;
                let p_clone = prompt.clone();
                let stage1_timeout_secs = std::env::var("VRYX_STAGE1_TIMEOUT_S")
                    .ok()
                    .and_then(|s| s.parse().ok())
                    .unwrap_or_else(|| env_u64_clamped("VRYX_INFERENCE_TIMEOUT_S", 600, 600, 3600))
                    .clamp(600, 3600);
                tokio::spawn(async move {
                    match tokio::time::timeout(Duration::from_secs(stage1_timeout_secs), call_local_inference(
                        grpc_port,
                        p_clone.as_bytes().to_vec(),
                        "text".to_string(),
                        vec![],
                        String::new(),
                    ))
                    .await
                    {
                        Ok(Ok((data, c, s, m, c_ms))) => {
                            let pipe = m.pipeline_trace_json.clone();
                            let _ = tx_stage1.send(InferenceResult::Stage1 {
                                peer_id: peer,
                                data,
                                c,
                                s,
                                continuation_response_tx: None,
                                request_started,
                                pipeline_trace_json: pipe,
                                compute_time_ms: c_ms,
                            });
                        }
                        Ok(Err(e)) => {
                            let _ = tx_stage1.send(InferenceResult::Error {
                                context: "Stage 1".to_string(),
                                message: e.to_string(),
                            });
                        }
                        Err(_) => {
                            let _ = tx_stage1.send(InferenceResult::Error {
                                context: "Stage 1 timeout".to_string(),
                                message: format!(
                                    "Stage 1 n'a pas répondu après {}s. Vérifiez que les workers compatibles avec le modèle sont actifs.",
                                    stage1_timeout_secs
                                ),
                            });
                        }
                    }
                });
                chat_state = ChatState::Generating {
                    response_tx: resp_opt.take(),
                    request_started,
                };
                true
            } else {
                println!(
                    "[!] Aucun worker découvert pour l'instant. \
                     Attendez la connexion au bootstrap…"
                );
                if let Some(tx) = resp_opt.take() {
                    let _ = tx.send(serde_json::json!({
                        "ok": false,
                        "error": "Aucun worker P2P connecté encore (découverte API ou relais en cours). Vérifiez le bootstrap et les journaux initiateur (« Pré-chat », « Dial », « Connexion établie »). Réessayez après quelques secondes si les workers ont un heartbeat récent."
                    }));
                }
                print!("> Vous : ");
                let _ = tokio::io::stdout().flush().await;
                false
            }
        }};
    }

    macro_rules! drain_chat_pending_after_idle {
        () => {
            while matches!(chat_state, ChatState::Idle) {
                let Some((ql, qtx)) = chat_pending.pop_front() else {
                    break;
                };
                if try_start_chat_inference!(ql, qtx) {
                    break;
                }
            }
        };
    }

    // Stage 1 part par gRPC local : les connexions relay peuvent être vides alors que Python orchestre encore des workers ;
    // tant que l’API liste des workers ou qu’un pair non-bootstrap reste dans `active_peers`, on ne doit pas court-circuiter.
    let chat_cancel_keepalive_signal = {
        let active_for_cancel = Arc::clone(&active_peers);
        let boot_cancel = bootstrap_peer_id;
        let registry_for_cancel = Arc::clone(&initiator_registry_workers);
        move || {
            let has_non_boot_connected = active_for_cancel
                .lock()
                .unwrap()
                .iter()
                .any(|p| !boot_cancel.is_some_and(|b| *p == b));
            has_non_boot_connected
                || registry_for_cancel.load(Ordering::Relaxed) > 0
        }
    };

    // ── Boucle principale ─────────────────────────────────────────────────
    loop {
        tokio::select! {
            // ── Relais HTTP → P2P (orchestrateur Python stage 1) ─────────
            relay_cmd = p2p_relay_rx.recv(), if args.mode == "initiator" => {
                let Some((peer, req, reply_tx)) = relay_cmd else { continue };
                let req_clone = req.clone();
                let relay_started = Instant::now();
                let hidden_bytes = req_clone.data.len() as u64;
                let persistent_relay = true;
                let connected_now = active_peers.lock().unwrap().contains(&peer);
                let connection_reuse = connected_now;
                if connected_now {
                    let req_id = swarm
                        .behaviour_mut()
                        .request_response
                        .send_request(&peer, req);
                    pending_requests.insert(req_id, (req_clone, PendingMeta::P2pRelayReply {
                        reply_tx,
                        relay_started,
                        hidden_bytes,
                        persistent_relay,
                        connection_reuse,
                    }));
                } else {
                    eprintln!(
                        "[P2P] Relais HTTP vers {} avant connexion P2P : dial circuit bootstrap + envoi opportuniste (payload ~ {:.1} Ko)",
                        peer,
                        hidden_bytes as f64 / 1024.0
                    );
                    if let Some(bs) = args
                        .bootstrap_node
                        .as_ref()
                        .map(|s| s.trim())
                        .filter(|s| !s.is_empty())
                    {
                        let relay_addr_str =
                            format!("{}/p2p-circuit/p2p/{}", bs.trim_end_matches('/'), peer);
                        if let Ok(ma) = relay_addr_str.parse::<Multiaddr>() {
                            swarm.behaviour_mut().kad.add_address(&peer, ma.clone());
                            swarm.add_peer_address(peer, ma.clone());
                            if let Err(e) = swarm.dial(ma) {
                                eprintln!("[!] Relais dial circuit vers worker : {:?}", e);
                            }
                        }
                    }
                    let req_id = swarm
                        .behaviour_mut()
                        .request_response
                        .send_request(&peer, req);
                    pending_requests.insert(req_id, (req_clone, PendingMeta::P2pRelayReply {
                        reply_tx,
                        relay_started,
                        hidden_bytes,
                        persistent_relay,
                        connection_reuse,
                    }));
                }
            }

            // ── stdin : chat initiator ──────────────────────────────────
            maybe_line = cmd_rx.recv(), if args.mode == "initiator" => {
                let (line, resp_tx) = match maybe_line {
                    Some(l) => l,
                    None => continue,
                };
                if line.is_empty() { continue }

                // Auto-reset : si l'inférence dépasse VRYX_INFERENCE_TIMEOUT_S (défaut 600s)
                // ou si plus aucun worker n'est actif, on débloque le state immédiatement.
                let inference_timeout_secs: u64 = std::env::var("VRYX_INFERENCE_TIMEOUT_S")
                    .ok()
                    .and_then(|s| s.parse().ok())
                    .unwrap_or(600)
                    .clamp(600, 3600);
                if let ChatState::Generating { request_started, .. } = &chat_state {
                    let no_workers_for_cancel = !chat_cancel_keepalive_signal();
                    let elapsed = request_started.elapsed().as_secs();
                    if elapsed > inference_timeout_secs {
                        eprintln!(
                            "[!] ChatState::Generating expiré ({}s > {}s), reset à Idle.",
                            elapsed, inference_timeout_secs
                        );
                        // Renvoyer une erreur propre à la requête en attente
                        if let ChatState::Generating { response_tx, .. } = &mut chat_state {
                            if let Some(tx) = response_tx.take() {
                                let _ = tx.send(serde_json::json!({
                                    "ok": false,
                                    "error": format!(
                                        "Inférence expirée après {}s. Aucun résultat reçu.",
                                        elapsed
                                    ),
                                }));
                            }
                        }
                        chat_state = ChatState::Idle;
                        drain_chat_pending_after_idle!();
                    } else if no_workers_for_cancel && elapsed > 45 {
                        eprintln!(
                            "[!] Génération en cours mais aucun signal worker ({}s sans P2P ni registre API). Reset à Idle.",
                            elapsed
                        );
                        if let ChatState::Generating { response_tx, .. } = &mut chat_state {
                            if let Some(tx) = response_tx.take() {
                                let _ = tx.send(serde_json::json!({
                                    "ok": false,
                                    "error": "Aucun worker P2P actif. La génération a été annulée.",
                                }));
                            }
                        }
                        chat_state = ChatState::Idle;
                        drain_chat_pending_after_idle!();
                    }
                }

                if !matches!(chat_state, ChatState::Idle) {
                    if chat_pending.len() >= chat_queue_max {
                        println!(
                            "[!] File d'attente chat saturée (max {}).",
                            chat_queue_max
                        );
                        if let Some(tx) = resp_tx {
                            let _ = tx.send(serde_json::json!({
                                "ok": false,
                                "error": format!(
                                    "Trop de requêtes en file d'attente (max {}). Réessayez après les réponses en cours.",
                                    chat_queue_max
                                ),
                            }));
                        }
                    } else {
                        println!(
                            "[*] Génération en cours : requête mise en file (position {}).",
                            chat_pending.len() + 1
                        );
                        chat_pending.push_back((line, resp_tx));
                    }
                    continue;
                }

                if args.mode == "initiator" {
                    if let Some(ref api_u) = args.api_url {
                        initiator_pull_workers_from_api_now(
                            &mut swarm,
                            &http_client,
                            api_u.as_str(),
                            bootstrap_peer_id,
                            args.bootstrap_node.as_ref(),
                            my_peer_id,
                            &mut discovered_peers,
                            &active_peers,
                            Some(&initiator_registry_workers),
                            Some(&initiator_registry_worker_peers),
                            "chat",
                        )
                        .await;
                    }
                }

                let _ = try_start_chat_inference!(line, resp_tx);
            }

            // ── Résultats d'inférence (async) ──────────────────────────
            res = rx.recv() => {
                if let Some(result) = res {
                    match result {
                        InferenceResult::Stage1 { peer_id, data, c, s, continuation_response_tx, request_started, pipeline_trace_json, compute_time_ms } => {
                            let sched_warm = 0_u32;
                            let mut sched_workers = 1_u32;
                            if let Ok(v) = serde_json::from_str::<serde_json::Value>(&pipeline_trace_json) {
                                if let Some(arr) = v.get("steps").and_then(|s| s.as_array()) {
                                    sched_workers = (arr.len() as u32).max(1);
                                }
                                if let Some(arr) = v.get("peers").and_then(|s| s.as_array()) {
                                    sched_workers = (arr.len() as u32).max(sched_workers);
                                }
                            }

                            // Inférence terminée côté Python (worker-only ou tensor-parallel réussi) :
                            // pas de warmup P2P nécessaire, on répond directement.
                            let pipeline_val_parsed = serde_json::from_str::<serde_json::Value>(&pipeline_trace_json).ok();
                            let pipeline_failed = pipeline_val_parsed.as_ref().map(|v| {
                                v.get("ok").and_then(|x| x.as_bool()) == Some(false)
                            }).unwrap_or(false);
                            if pipeline_failed {
                                let response_tx = continuation_response_tx.or_else(|| {
                                    match &mut chat_state {
                                        ChatState::Generating { response_tx, .. } => response_tx.take(),
                                        _ => None,
                                    }
                                });
                                let pipeline_value = pipeline_val_parsed.clone().unwrap_or(serde_json::Value::Null);
                                let err = pipeline_value
                                    .get("error")
                                    .and_then(|x| x.as_str())
                                    .unwrap_or("Capacité P2P worker-only indisponible.");
                                if let Some(tx) = response_tx {
                                    let rp = routing_path_from_trace(&pipeline_value);
                                    let _ = tx.send(serde_json::json!({
                                        "ok": false,
                                        "error": err,
                                        "latency_ms": request_started.elapsed().as_millis() as u64,
                                        "compute_time_ms": compute_time_ms,
                                        "worker_compute_ms": compute_time_ms,
                                        "routing_path": rp,
                                        "pipeline_trace": pipeline_value,
                                    }));
                                }
                                chat_state = ChatState::Idle;
                                drain_chat_pending_after_idle!();
                                print!("> Vous : ");
                                let _ = tokio::io::stdout().flush().await;
                                continue;
                            }
                            let worker_only_skip = pipeline_val_parsed.as_ref().map(|v| {
                                let layout = v.get("layout").and_then(|x| x.as_str()).unwrap_or("");
                                let ok = v.get("ok").and_then(|x| x.as_bool()).unwrap_or(false);
                                // Court-circuiter le warmup P2P si Python a déjà géré la computation
                                let skip_layouts = ["worker_only_pipeline", "pipeline_relay_daisy_chain", "distributed_fanout", "mlx_lm_direct_p2p"];
                                ok && skip_layouts.contains(&layout)
                            }).unwrap_or(false);

                            if worker_only_skip {
                                let final_text = String::from_utf8_lossy(&data).to_string();
                                let (pt, ct, tt, vps_ms) = pipeline_val_parsed.as_ref()
                                    .and_then(|v| v.get("metrics").cloned())
                                    .map(|m| {
                                        let pt = m.get("prompt_tokens").and_then(|x| x.as_u64()).unwrap_or(0);
                                        let ct = m.get("completion_tokens").and_then(|x| x.as_u64()).unwrap_or(0);
                                        let tt = m
                                            .get("total_tokens")
                                            .and_then(|x| x.as_u64())
                                            .unwrap_or(pt.saturating_add(ct));
                                        let vps_ms = m.get("vps_delegate_ms").and_then(|x| x.as_u64()).unwrap_or(0);
                                        (pt, ct, tt, vps_ms)
                                    })
                                    .unwrap_or((0, 0, 0, 0));
                                if pt > 0 {
                                    tokens_in.fetch_add(pt, Ordering::Relaxed);
                                }
                                if ct > 0 {
                                    tokens_out.fetch_add(ct, Ordering::Relaxed);
                                    tokens_generated.fetch_add(ct, Ordering::Relaxed);
                                }

                                let response_tx = continuation_response_tx.or_else(|| {
                                    match &mut chat_state {
                                        ChatState::Generating { response_tx, .. } => response_tx.take(),
                                        _ => None,
                                    }
                                });
                                let pipeline_value: serde_json::Value =
                                    serde_json::from_str(&pipeline_trace_json)
                                        .unwrap_or(serde_json::Value::Null);
                                let pipeline_steps = pipeline_value
                                    .get("generation_steps")
                                    .cloned()
                                    .or_else(|| pipeline_value.get("steps").cloned())
                                    .unwrap_or(serde_json::Value::Array(vec![]));
                                let peer_str = peer_id.to_string();
                                let latency_ms = request_started.elapsed().as_millis() as u64;
                                if let Some(tx) = response_tx {
                                    let rp = routing_path_from_trace(&pipeline_value);
                                    let _ = tx.send(serde_json::json!({
                                        "ok": true,
                                        "response": final_text,
                                        "worker_peer_id": peer_str,
                                        "primary_worker_peer_id": peer_str,
                                        "latency_ms": latency_ms,
                                        "prompt_tokens": pt,
                                        "completion_tokens": ct,
                                        "total_tokens": tt,
                                        "vps_delegate_ms": vps_ms,
                                        "worker_compute_ms": compute_time_ms,
                                        "compute_time_ms": compute_time_ms,
                                        "routing_path": rp,
                                        "p2p_messages_in": 0_u64,
                                        "p2p_messages_out": 0_u64,
                                        "tokens_in": 0,
                                        "tokens_out": 0,
                                        "tokens_generated": ct,
                                        "cumulative_tokens_in": tokens_in.load(Ordering::Relaxed),
                                        "cumulative_tokens_out": tokens_out.load(Ordering::Relaxed),
                                        "cumulative_tokens_generated": tokens_generated.load(Ordering::Relaxed),
                                        "shard_session_id": "",
                                        "scheduler_warmup_sent": sched_warm,
                                        "scheduler_workers_used": sched_workers,
                                        "pipeline_trace": pipeline_value,
                                        "pipeline_workers": pipeline_steps,
                                    }));
                                }
                                chat_state = ChatState::Idle;
                                drain_chat_pending_after_idle!();
                                print!("> Vous : ");
                                let _ = tokio::io::stdout().flush().await;
                                continue;
                            }

                            let response_tx = continuation_response_tx.or_else(|| {
                                match &mut chat_state {
                                    ChatState::Generating { response_tx, .. } => response_tx.take(),
                                    _ => None,
                                }
                            });
                            let pipeline_value: serde_json::Value =
                                serde_json::from_str(&pipeline_trace_json)
                                    .unwrap_or(serde_json::Value::Null);
                            if let Some(tx) = response_tx {
                                let rp = routing_path_from_trace(&pipeline_value);
                                let _ = tx.send(serde_json::json!({
                                    "ok": false,
                                    "error": "capacité worker de génération distribuée non disponible",
                                    "latency_ms": request_started.elapsed().as_millis() as u64,
                                    "compute_time_ms": compute_time_ms,
                                    "worker_compute_ms": compute_time_ms,
                                    "routing_path": rp,
                                    "pipeline_trace": pipeline_value,
                                }));
                            }
                            chat_state = ChatState::Idle;
                            drain_chat_pending_after_idle!();
                            print!("> Vous : ");
                            let _ = tokio::io::stdout().flush().await;
                            let _ = (peer_id, data, c, s, sched_warm, sched_workers);
                        }
                        InferenceResult::Stage2 { channel, data, c, s, metrics, compute_time_ms } => {
                            let w_ms = compute_time_ms;
                            let data_len = data.len();
                            let send_result = swarm.behaviour_mut().request_response.send_response(
                                channel,
                                TensorResponse {
                                    data,
                                    compute_time_ns: c,
                                    serialization_time_ns: s,
                                    prompt_tokens_llm: metrics.prompt_tokens,
                                    completion_tokens_llm: metrics.completion_tokens,
                                    total_tokens_llm: metrics.total_tokens,
                                    vps_delegate_ms: metrics.vps_delegate_ms,
                                    worker_compute_ms: w_ms,
                                    compute_time_ms,
                                    ..Default::default()
                                },
                            );
                            match send_result {
                                Ok(()) => eprintln!(
                                    "[P2P] Réponse Stage2 envoyée au demandeur bytes={} compute_ms={} completion={}",
                                    data_len,
                                    compute_time_ms,
                                    metrics.completion_tokens
                                ),
                                Err(_) => eprintln!(
                                    "[P2P] Échec send_response Stage2 : canal déjà fermé bytes={} compute_ms={}",
                                    data_len,
                                    compute_time_ms
                                ),
                            }
                        }
                        InferenceResult::Stage2Error { channel, message } => {
                            eprintln!("[!] Inférence Stage 2 échouée : {}", message);
                            // Send an error response so the initiator doesn't get EOF
                            let _ = swarm.behaviour_mut().request_response.send_response(
                                channel,
                                TensorResponse {
                                    data: serde_json::json!({
                                        "ok": false,
                                        "error": message,
                                    }).to_string().into_bytes(),
                                    ..Default::default()
                                },
                            );
                        }
                        InferenceResult::PipelineForward { target_peer, request, original_channel } => {
                            let req_id = swarm.behaviour_mut().request_response.send_request(&target_peer, request.clone());
                            pending_requests.insert(req_id, (request, PendingMeta::Forwarded { original_channel }));
                        }
                        InferenceResult::Error { context, message } => {
                            eprintln!("\n[!] Inférence {} échouée : {}", context, message);
                            if context == "Stage 1" || context.starts_with("Stage 1") {
                                let rtx = match &mut chat_state {
                                    ChatState::Generating { response_tx, .. } => response_tx.take(),
                                    _ => None,
                                };
                                if let Some(tx) = rtx {
                                    let _ = tx.send(serde_json::json!({
                                        "ok": false,
                                        "error": format!("Stage 1 : {}", message),
                                    }));
                                }
                                chat_state = ChatState::Idle;
                                drain_chat_pending_after_idle!();
                                print!("> Vous : ");
                                let _ = tokio::io::stdout().flush().await;
                            }
                        }
                    }
                }
            }

            // ── Bootstrap kad refresh ──────────────────────────────────
            _ = bootstrap_interval.tick() => {
                let _ = swarm.behaviour_mut().kad.bootstrap();
                // On cherche activement les autres pairs pour forcer la découverte
                let local_peer_id = *swarm.local_peer_id();
                swarm.behaviour_mut().kad.get_closest_peers(local_peer_id);
            }

            // ── Heartbeat status ───────────────────────────────────────
            _ = heartbeat_interval.tick() => {
                // Surveillance périodique du ChatState : reset si expiré ou sans workers.
                if args.mode == "initiator" {
                    let inference_timeout_secs: u64 = std::env::var("VRYX_INFERENCE_TIMEOUT_S")
                        .ok()
                        .and_then(|s| s.parse().ok())
                        .unwrap_or(600)
                        .clamp(600, 3600);
                    if let ChatState::Generating { request_started, .. } = &chat_state {
                        let no_workers_for_cancel = !chat_cancel_keepalive_signal();
                        let elapsed = request_started.elapsed().as_secs();
                        let expired = elapsed > inference_timeout_secs;
                        let stuck_no_worker = no_workers_for_cancel && elapsed > 120;
                        if expired || stuck_no_worker {
                            eprintln!(
                                "[!] Heartbeat : ChatState::Generating bloqué {}s (expired={}, no_workers={}), reset à Idle.",
                                elapsed, expired, stuck_no_worker
                            );
                            if let ChatState::Generating { response_tx, .. } = &mut chat_state {
                                if let Some(tx) = response_tx.take() {
                                    let reason = if stuck_no_worker {
                                        "Aucun worker P2P actif. La génération a été annulée.".to_string()
                                    } else {
                                        format!("Inférence expirée après {}s.", elapsed)
                                    };
                                    let _ = tx.send(serde_json::json!({
                                        "ok": false,
                                        "error": reason,
                                    }));
                                }
                            }
                            chat_state = ChatState::Idle;
                            drain_chat_pending_after_idle!();
                        }
                    }
                    // Relay HTTP : timeouts des requêtes en file avant connexion P2P
                    let relay_deadline_secs: u64 = std::env::var("VRYX_RELAY_PEER_CONNECT_DEADLINE_SEC")
                        .ok()
                        .and_then(|s| s.parse().ok())
                        .unwrap_or(180_u64)
                        .max(45);
                    let relay_deadline = Duration::from_secs(relay_deadline_secs);
                    let now_hb = Instant::now();
                    for (_pt, dq) in pending_relay_until_connected.iter_mut() {
                        while dq.front().is_some_and(|(_, _, enq)| {
                            now_hb.saturating_duration_since(*enq) > relay_deadline
                        }) {
                            if let Some((_r, rtx, _)) = dq.pop_front() {
                                let _ = rtx.send(Err(format!(
                                    "RelayPeerConnectTimeout:{}s connexion absent vers worker (vérifier workers + bootstrap relay).",
                                    relay_deadline_secs
                                )));
                                eprintln!("[!] Relay fichier attente abandonnée (timeout {}s avant connexion P2P).", relay_deadline_secs);
                            }
                        }
                    }
                    pending_relay_until_connected.retain(|_, dq| !dq.is_empty());
                    let waiting: Vec<PeerId> = pending_relay_until_connected.keys().copied().collect();
                    'redial_lp: for pt in waiting {
                        if active_peers.lock().unwrap().contains(&pt) {
                            continue 'redial_lp;
                        }
                        if let Some(bs) = args.bootstrap_node.as_ref().map(|s| s.trim()).filter(|s| !s.is_empty()) {
                            let relay_addr_str = format!("{}/p2p-circuit/p2p/{}", bs.trim_end_matches('/'), pt);
                            if let Ok(ma) = relay_addr_str.parse::<Multiaddr>() {
                                swarm.behaviour_mut().kad.add_address(&pt, ma.clone());
                                let _ = swarm.dial(ma);
                            }
                        }
                    }
                }

                if let Some(api_url) = &args.api_url {
                    let runtime_backend = std::env::var("VRYX_RUNTIME_BACKEND")
                        .ok()
                        .filter(|v| !v.trim().is_empty())
                        .unwrap_or_else(|| {
                            if std::env::var("VRYX_ENABLE_MLX_RUNTIME")
                                .map(|v| matches!(v.to_lowercase().as_str(), "1" | "true" | "yes"))
                                .unwrap_or(false)
                            {
                                "mlx".to_string()
                            } else {
                                "pytorch".to_string()
                            }
                        })
                        .to_lowercase();
                    let supports_mlx = matches!(runtime_backend.as_str(), "mlx" | "mlx_lm")
                        || std::env::var("VRYX_SUPPORTS_MLX")
                            .map(|v| matches!(v.to_lowercase().as_str(), "1" | "true" | "yes"))
                            .unwrap_or(false)
                        || std::env::var("VRYX_ENABLE_MLX_RUNTIME")
                            .map(|v| matches!(v.to_lowercase().as_str(), "1" | "true" | "yes"))
                            .unwrap_or(false);
                    let weight_quantization = std::env::var("VRYX_WEIGHT_QUANTIZATION")
                        .ok()
                        .filter(|v| !v.trim().is_empty())
                        .unwrap_or_else(|| "fp16".to_string())
                        .to_lowercase();
                    let supports_q4_weights = supports_mlx
                        || weight_quantization == "q4"
                        || std::env::var("VRYX_SUPPORTS_Q4_WEIGHTS")
                            .map(|v| matches!(v.to_lowercase().as_str(), "1" | "true" | "yes"))
                            .unwrap_or(false);
                    let mut gpu_name = std::env::var("VRYX_GPU_NAME").ok();
                    let mut gpu_vram_mb = std::env::var("VRYX_GPU_VRAM_MB")
                        .ok()
                        .and_then(|v| v.parse::<u64>().ok());
                    if gpu_name.is_none() || gpu_vram_mb.is_none() {
                        let (hint_name, hint_vram) = heartbeat_gpu_hints_cached();
                        if gpu_name.is_none() {
                            gpu_name = hint_name;
                        }
                        if gpu_vram_mb.is_none() {
                            gpu_vram_mb = hint_vram;
                        }
                    }
                    let (allocated_vram_mb, memory_limit_percent) = heartbeat_allocated_vram_mb(gpu_vram_mb);
                    let machine_info = std::env::var("VRYX_MACHINE_INFO")
                        .ok()
                        .and_then(|raw| serde_json::from_str::<serde_json::Value>(&raw).ok())
                        .filter(|v| v.is_object());
                    let payload = HeartbeatPayload {
                        peer_id: my_peer_id.to_string(),
                        mode: args.mode.clone(),
                        grpc_port: if args.mode == "worker" { Some(args.grpc_port) } else { None },
                        p2p_port: if args.p2p_port > 0 { Some(args.p2p_port) } else { None },
                        version: std::env::var("VRYX_WORKER_VERSION")
                            .ok()
                            .filter(|v| !v.trim().is_empty())
                            .unwrap_or_else(|| env!("CARGO_PKG_VERSION").to_string()),
                        user_id: args.user_id,
                        tokens_in: tokens_in.load(Ordering::Relaxed),
                        tokens_out: tokens_out.load(Ordering::Relaxed),
                        tokens_generated: tokens_generated.load(Ordering::Relaxed),
                        p2p_peers: active_peers.lock().unwrap().len(),
                        model: model_name.clone(),
                        gpu_name,
                        gpu_vram_mb,
                        allocated_vram_mb,
                        memory_limit_percent,
                        runtime_backend: Some(runtime_backend),
                        weight_quantization: Some(weight_quantization),
                        supports_q4_weights,
                        supports_mlx,
                        supports_vllm: std::env::var("VRYX_SUPPORTS_VLLM")
                            .map(|v| matches!(v.to_lowercase().as_str(), "1" | "true" | "yes"))
                            .unwrap_or(false),
                        machine_info,
                    };
                    send_heartbeat(&http_client, api_url, &payload).await;

                    // Initiator: fallback robuste de découverte depuis les heartbeats API.
                    if args.mode == "initiator" {
                        initiator_pull_workers_from_api_now(
                            &mut swarm,
                            &http_client,
                            api_url,
                            bootstrap_peer_id,
                            args.bootstrap_node.as_ref(),
                            my_peer_id,
                            &mut discovered_peers,
                            &active_peers,
                            Some(&initiator_registry_workers),
                            Some(&initiator_registry_worker_peers),
                            "heartbeat",
                        )
                        .await;
                    }
                }
            }

            // ── Événements swarm ───────────────────────────────────────
            event = swarm.select_next_some() => match event {
                    SwarmEvent::NewListenAddr { address, .. } => {
                        println!("[+] En écoute sur : {}", address);
                        let _ = tokio::io::stdout().flush().await;
                    }
                    SwarmEvent::ListenerError { listener_id, error } => {
                        eprintln!("[!] Erreur listener {:?}: {:?}", listener_id, error);
                    }
                    SwarmEvent::ConnectionEstablished { peer_id, endpoint, .. } => {
                        println!("[P2P] Connexion établie avec {} ({:?})", peer_id, endpoint);
                        peer_transports.lock().unwrap().insert(
                            peer_id,
                            endpoint.get_remote_address().to_string(),
                        );
                        let first_logical_link = {
                            let mut c = peer_connection_count.lock().unwrap();
                            let n = c.entry(peer_id).or_insert(0);
                            *n += 1;
                            *n == 1
                        };
                        if first_logical_link {
                            active_peers.lock().unwrap().insert(peer_id);
                            if args.mode == "initiator"
                                && Some(peer_id) != bootstrap_peer_id
                                && peer_id != my_peer_id
                            {
                                if let Some(q) = pending_relay_until_connected.remove(&peer_id) {
                                    if !q.is_empty() {
                                        eprintln!(
                                            "[P2P] Connexion ouverte avec {} → envoi de {} requête(s) relay retardée(s)",
                                            peer_id,
                                            q.len()
                                        );
                                        for (r, rtx, _) in q {
                                            let r_clone = r.clone();
                                            let relay_started_i = Instant::now();
                                            let hidden_b = r_clone.data.len() as u64;
                                            let req_id_i = swarm
                                                .behaviour_mut()
                                                .request_response
                                                .send_request(&peer_id, r);
                                            pending_requests.insert(
                                                req_id_i,
                                                (
                                                    r_clone,
                                                    PendingMeta::P2pRelayReply {
                                                        reply_tx: rtx,
                                                        relay_started: relay_started_i,
                                                        hidden_bytes: hidden_b,
                                                        persistent_relay: true,
                                                        connection_reuse: false,
                                                    },
                                                ),
                                            );
                                        }
                                    }
                                }
                            }
                        }
                        println!("[P2P_READY] Connecté au réseau P2P");
                        let _ = tokio::io::stdout().flush().await;
                        if let Some(boot_id) = bootstrap_peer_id {
                            if boot_id == peer_id && (args.mode == "worker" || args.mode == "initiator") {
                                if let Some(boot_addr_str) = &args.bootstrap_node {
                                    let relay_addr = boot_addr_str.parse::<Multiaddr>().unwrap()
                                        .with(libp2p::multiaddr::Protocol::P2pCircuit);
                                    println!("[P2P] Tentative d'écoute relay via {}...", peer_id);
                                    if let Err(e) = swarm.listen_on(relay_addr.clone()) {
                                        eprintln!("[!] Échec listen relay : {:?}", e);
                                    } else {
                                        swarm.add_external_address(relay_addr);
                                    }
                                }
                            }
                        }
                    }
                SwarmEvent::ConnectionClosed { peer_id, .. } => {
                    println!("[P2P] Connexion fermée : {}", peer_id);
                    let disconnect_peer_entirely = {
                        let mut c = peer_connection_count.lock().unwrap();
                        match c.get_mut(&peer_id) {
                            Some(n) if *n <= 1 => {
                                c.remove(&peer_id);
                                true
                            }
                            Some(n) => {
                                *n -= 1;
                                false
                            }
                            None => true,
                        }
                    };
                    if disconnect_peer_entirely {
                        active_peers.lock().unwrap().remove(&peer_id);
                        peer_transports.lock().unwrap().remove(&peer_id);
                        if Some(peer_id) != bootstrap_peer_id {
                            discovered_peers.remove(&peer_id);
                        }
                    }
                }

                // mDNS (LAN uniquement, ignoré si bootstrap WAN configuré)
                SwarmEvent::Behaviour(VryxBehaviourEvent::Mdns(mdns::Event::Discovered(list))) => {
                    if args.bootstrap_node.is_some() { continue; }
                    for (peer_id, multiaddr) in list {
                        if discovered_peers.insert(peer_id) {
                            println!("[LAN] Pair mDNS découvert : {} @ {}", peer_id, multiaddr);
                            swarm.behaviour_mut().kad.add_address(&peer_id, multiaddr);
                        }
                    }
                }

                // Identify : ajoute les adresses à Kademlia
                SwarmEvent::Behaviour(VryxBehaviourEvent::Identify(
                    identify::Event::Received { peer_id, info },
                )) => {
                    println!("[P2P] Identify reçu de {} : addrs={:?} (observed={:?})", peer_id, info.listen_addrs, info.observed_addr);
                    let is_bootstrap = bootstrap_peer_id.map_or(false, |id| id == peer_id);
                    for addr in info.listen_addrs {
                        swarm.behaviour_mut().kad.add_address(&peer_id, addr.clone());
                        swarm.add_peer_address(peer_id, addr.clone());
                        if !is_bootstrap {
                            println!("[P2P] Adresse ajoutée pour {} : {}", peer_id, addr);
                        }
                    }
                    if info.protocols.iter().any(|p| p.as_ref().starts_with("/vryx/")) {
                        if !is_bootstrap && discovered_peers.insert(peer_id) {
                            println!("[P2P] Vryx worker découvert (Identify) : {}", peer_id);
                        }
                        if args.mode == "initiator" && !is_bootstrap && peer_id != my_peer_id {
                            if let Some(q) = pending_relay_until_connected.remove(&peer_id) {
                                if !q.is_empty() {
                                    eprintln!(
                                        "[P2P] Identify worker {} → envoi de {} requête(s) relay retardée(s)",
                                        peer_id,
                                        q.len()
                                    );
                                    for (r, rtx, _) in q {
                                        let r_clone = r.clone();
                                        let relay_started_i = Instant::now();
                                        let hidden_b = r_clone.data.len() as u64;
                                        let req_id_i = swarm
                                            .behaviour_mut()
                                            .request_response
                                            .send_request(&peer_id, r);
                                        pending_requests.insert(
                                            req_id_i,
                                            (
                                                r_clone,
                                                PendingMeta::P2pRelayReply {
                                                    reply_tx: rtx,
                                                    relay_started: relay_started_i,
                                                    hidden_bytes: hidden_b,
                                                    persistent_relay: true,
                                                    connection_reuse: false,
                                                },
                                            ),
                                        );
                                    }
                                }
                            }
                        }
                    }
                }

                // Kad : mise à jour de la table de routage
                SwarmEvent::Behaviour(VryxBehaviourEvent::Kad(
                    kad::Event::RoutingUpdated { peer, .. },
                )) => {
                    println!("[P2P] RoutingUpdated pour : {}", peer);
                    if Some(peer) == bootstrap_peer_id { continue; }
                    if discovered_peers.insert(peer) {
                        println!("[P2P] Pair Kad découvert (RoutingUpdated) : {}", peer);
                    }
                }

                SwarmEvent::Behaviour(VryxBehaviourEvent::Kad(kad::Event::OutboundQueryProgressed {
                    result: kad::QueryResult::GetClosestPeers(Ok(ok)),
                    ..
                })) => {
                    println!("[P2P] Query Kad terminée : {} pairs trouvés", ok.peers.len());
                    for peer_id in ok.peers {
                        if Some(peer_id) == bootstrap_peer_id { continue; }
                        if discovered_peers.insert(peer_id) {
                            println!("[P2P] Pair Kad découvert (Query) : {}", peer_id);
                        }
                    }
                }

                SwarmEvent::Behaviour(VryxBehaviourEvent::RelayClient(event)) => {
                    println!("[P2P] Relay Client : {:?}", event);
                }
                SwarmEvent::Behaviour(VryxBehaviourEvent::RelayServer(event)) => {
                    println!("[P2P] Relay Server : {:?}", event);
                }
                SwarmEvent::Behaviour(VryxBehaviourEvent::Dcutr(event)) => {
                    println!("[P2P] DCUTR : {:?}", event);
                }

                // Requête P2P entrante → exécute l'inférence stage 2
                SwarmEvent::Behaviour(VryxBehaviourEvent::RequestResponse(
                    request_response::Event::Message {
                        peer,
                        message: request_response::Message::Request { request, channel, .. },
                        ..
                    },
                )) => {
                    if args.mode == "bootstrap" { continue; }
                    println!("[<] Requête P2P reçue de {} ({})", peer, request.dtype);
                    let tx_stage2 = tx.clone();
                    let grpc_port = args.grpc_port;
                    let dtype_in = request.dtype.clone();
                    let prior_compute_ns = request.compute_time_ns;
                    let trace_shard = Arc::clone(&last_shard_trace);
                    let mut routing_path = request.routing_path.clone();
                    let session_id = request.session_id.clone();
                    let (estimated_prompt_tokens, _estimated_completion_tokens) =
                        estimate_chat_token_deltas(&request.data);
                    let tokens_in_stage2 = Arc::clone(&tokens_in);
                    let tokens_out_stage2 = Arc::clone(&tokens_out);
                    let tokens_generated_stage2 = Arc::clone(&tokens_generated);

                    tokio::spawn(async move {
                        match call_local_inference(grpc_port, request.data, request.dtype, routing_path.clone(), session_id.clone()).await {
                            Ok((data, c, s, mut metrics, c_ms)) => {
                                eprintln!(
                                    "[P2P] Inférence locale terminée dtype={} bytes={} compute_ms={} prompt={} completion={} total={}",
                                    dtype_in,
                                    data.len(),
                                    c_ms,
                                    metrics.prompt_tokens,
                                    metrics.completion_tokens,
                                    metrics.total_tokens
                                );
                                let response_is_error = response_data_is_error(&data);
                                let count_llm_tokens = matches!(
                                    dtype_in.as_str(),
                                    "vryx.mlx_lm.generate"
                                        | "vryx.llama_cpp.generate"
                                        | "vryx.llm.generate"
                                        | "vryx.chat.generate"
                                );
                                let prompt_delta = if response_is_error || !count_llm_tokens {
                                    0
                                } else {
                                    metrics.prompt_tokens.max(estimated_prompt_tokens)
                                };
                                let parsed_completion_tokens = completion_tokens_from_response_data(&data);
                                let completion_delta = if response_is_error || !count_llm_tokens {
                                    0
                                } else if metrics.completion_tokens > 0 {
                                    metrics.completion_tokens
                                } else if parsed_completion_tokens > 0 {
                                    parsed_completion_tokens
                                } else {
                                    estimate_text_tokens(&data).min(64)
                                };
                                if prompt_delta > 0 {
                                    tokens_in_stage2.fetch_add(prompt_delta, Ordering::Relaxed);
                                }
                                if completion_delta > 0 {
                                    tokens_out_stage2.fetch_add(completion_delta, Ordering::Relaxed);
                                    tokens_generated_stage2.fetch_add(completion_delta, Ordering::Relaxed);
                                }
                                if count_llm_tokens && !response_is_error {
                                    if metrics.prompt_tokens == 0 && prompt_delta > 0 {
                                        metrics.prompt_tokens = prompt_delta;
                                    }
                                    if metrics.completion_tokens == 0 && completion_delta > 0 {
                                        metrics.completion_tokens = completion_delta;
                                    }
                                    if metrics.total_tokens == 0
                                        && (metrics.prompt_tokens > 0 || metrics.completion_tokens > 0)
                                    {
                                        metrics.total_tokens = metrics
                                            .prompt_tokens
                                            .saturating_add(metrics.completion_tokens);
                                    }
                                }
                                let total_compute_ns = prior_compute_ns.saturating_add(c);
                                let total_compute_ms = if dtype_in == "vryx.mlx_lm.generate" && c_ms > 0 {
                                    c_ms
                                } else {
                                    (total_compute_ns / 1_000_000).max(c_ms)
                                };
                                if dtype_in.starts_with("vryx.shard.")
                                    || dtype_in.starts_with("vryx.tp.")
                                    || dtype_in.starts_with("vryx.dist.")
                                    || dtype_in == "vryx.pipeline.forward"
                                {
                                    let _ = trace_shard.lock().unwrap().replace(serde_json::json!({
                                        "dtype": dtype_in,
                                        "shard_session_id": metrics.shard_session_id,
                                        "shard_layer_id": metrics.shard_layer_id,
                                        "compute_ms": c_ms,
                                        "ts_ms": std::time::SystemTime::now()
                                            .duration_since(std::time::UNIX_EPOCH)
                                            .map(|d| d.as_millis())
                                            .unwrap_or(0),
                                    }));
                                }

                                if !routing_path.is_empty() {
                                    let next_peer_str = routing_path.remove(0);
                                    if let Ok(next_peer) = PeerId::from_str(&next_peer_str) {
                                        let _ = tx_stage2.send(InferenceResult::PipelineForward {
                                            target_peer: next_peer,
                                            request: TensorRequest {
                                                kind: String::new(),
                                                data,
                                                dtype: dtype_in.clone(),
                                                compute_time_ns: total_compute_ns,
                                                serialization_time_ns: s,
                                                routing_path,
                                                session_id,
                                            },
                                            original_channel: channel,
                                        });
                                        return;
                                    }
                                }

                                if let Err(e) = tx_stage2.send(InferenceResult::Stage2 {
                                    channel,
                                    data,
                                    c: total_compute_ns,
                                    s,
                                    metrics,
                                    compute_time_ms: total_compute_ms,
                                }) {
                                    eprintln!("[P2P] Impossible de remettre la réponse Stage2 au swarm: {}", e);
                                }
                            }
                            Err(e) => {
                                eprintln!("[P2P] Inférence locale échouée dtype={} : {}", dtype_in, e);
                                let _ = tx_stage2.send(InferenceResult::Stage2Error {
                                    channel,
                                    message: e.to_string(),
                                });
                            }
                        }
                    });
                }

                // Réponse P2P reçue → token généré, continue le chat
                SwarmEvent::Behaviour(VryxBehaviourEvent::RequestResponse(
                    request_response::Event::Message {
                        peer: _,
                        message: request_response::Message::Response { response, request_id },
                        ..
                    },
                )) => {
                    match pending_requests.remove(&request_id) {
                        Some((_, PendingMeta::P2pRelayReply {
                            reply_tx,
                            relay_started,
                            hidden_bytes,
                            persistent_relay: _persistent_relay,
                            connection_reuse: _connection_reuse,
                        })) => {
                            let mut response_with_metrics = response.clone();
                            response_with_metrics.vps_delegate_ms = relay_started.elapsed().as_millis() as u64;
                            response_with_metrics.p2p_messages_in = hidden_bytes;
                            if response_with_metrics.serialization_time_ns == 0 {
                                response_with_metrics.serialization_time_ns = response.serialization_time_ns;
                            }
                            let _ = reply_tx.send(Ok(response_with_metrics));
                        }
                        Some((_, PendingMeta::Forwarded { original_channel })) => {
                            let _ = swarm.behaviour_mut().request_response.send_response(original_channel, response.clone());
                        }
                        None => {}
                    }
                    continue;
                }

                // Échec d'envoi → retry sur un autre worker
                SwarmEvent::Behaviour(VryxBehaviourEvent::RequestResponse(
                    request_response::Event::OutboundFailure {
                        peer, request_id, error, ..
                    },
                )) => {
                    eprintln!("[!] Échec envoi vers {} : {}", peer, error);
                    if let Some((req_retry, meta)) = pending_requests.remove(&request_id) {
                        match meta {
                            PendingMeta::P2pRelayReply { reply_tx, .. } => {
                                let es = format!("{:?}", error);
                                let dial_like_fail = args.mode == "initiator"
                                    && (es.contains("DialFailure")
                                        || es.contains("NotConnected"));
                                if dial_like_fail {
                                    eprintln!(
                                        "[P2P] Échec type dial après envoi relay → éviction vue connexion peer {} + mise en retry file",
                                        peer
                                    );
                                    active_peers.lock().unwrap().remove(&peer);
                                    peer_connection_count.lock().unwrap().remove(&peer);
                                    if let Some(bs) =
                                        args.bootstrap_node.as_ref().map(|s| s.trim()).filter(|s| !s.is_empty())
                                    {
                                        let relay_addr_str =
                                            format!("{}/p2p-circuit/p2p/{}", bs.trim_end_matches('/'), peer);
                                        if let Ok(ma) = relay_addr_str.parse::<Multiaddr>() {
                                            swarm.behaviour_mut().kad.add_address(&peer, ma.clone());
                                            let _ = swarm.dial(ma);
                                        }
                                    }
                                    pending_relay_until_connected.entry(peer).or_default().push_back((
                                        req_retry,
                                        reply_tx,
                                        Instant::now(),
                                    ));
                                } else {
                                    let _ = reply_tx.send(Err(es));
                                }
                                continue;
                            }
                            PendingMeta::Forwarded { original_channel } => {
                                let _ = swarm.behaviour_mut().request_response.send_response(
                                    original_channel,
                                    TensorResponse {
                                        data: serde_json::json!({
                                            "ok": false,
                                            "error": format!("Pipeline hop failed at {}: {}", peer, error),
                                        }).to_string().into_bytes(),
                                        ..Default::default()
                                    },
                                );
                                continue;
                            }
                        }
                    }
                }

                _ => {}
            }
        }
    }
}
