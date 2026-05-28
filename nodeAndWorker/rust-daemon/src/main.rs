#![recursion_limit = "256"]

use anyhow::Result;
use axum::body::{Body, Bytes};
use axum::extract::DefaultBodyLimit;
use axum::http::StatusCode;
use axum::response::Response;
use axum::{
    routing::{get, post},
    Json, Router,
};
use base64::Engine as _;
use clap::Parser;
use futures::{
    AsyncReadExt as FuturesAsyncReadExt, AsyncWriteExt as FuturesAsyncWriteExt, StreamExt,
};
use libp2p::{
    autonat, dcutr, identify, kad, noise, relay,
    request_response::{self, ProtocolSupport},
    swarm::{NetworkBehaviour, Swarm, SwarmEvent},
    tcp, yamux, Multiaddr, PeerId, StreamProtocol,
};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet, VecDeque};
use std::error::Error;
use std::hash::{Hash, Hasher};
use std::net::{Ipv4Addr, Ipv6Addr};
use std::path::PathBuf;
use std::str::FromStr;
use std::sync::{
    atomic::{AtomicU64, AtomicUsize, Ordering},
    Arc, Mutex, OnceLock,
};
use std::time::{Duration, Instant};
use tokio::io::AsyncWriteExt as TokioAsyncWriteExt;
use tokio::time;
use tower_http::cors::CorsLayer;

fn daemon_commit() -> &'static str {
    option_env!("VRYX_DAEMON_GIT_COMMIT").unwrap_or("unknown")
}

fn daemon_version_json() -> serde_json::Value {
    serde_json::json!({
        "name": "vryx-daemon",
        "version": env!("CARGO_PKG_VERSION"),
        "commit": daemon_commit(),
    })
}

// ============================================================
//  Codec P2P personnalisé (512 MB pour les poids de modèle)
// ============================================================

mod vryx_codec {
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
        fn default() -> Self {
            Codec {
                phantom: PhantomData,
            }
        }
    }

    impl<Req, Resp> Clone for Codec<Req, Resp> {
        fn clone(&self) -> Self {
            Self::default()
        }
    }

    #[async_trait::async_trait]
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
        where
            T: AsyncRead + Unpin + Send,
        {
            let mut buf = Vec::new();
            io.take(MAX_SIZE).read_to_end(&mut buf).await?;
            serde_json::from_slice(&buf).map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e))
        }

        async fn read_response<T>(
            &mut self,
            _protocol: &Self::Protocol,
            io: &mut T,
        ) -> io::Result<Self::Response>
        where
            T: AsyncRead + Unpin + Send,
        {
            let mut buf = Vec::new();
            io.take(MAX_SIZE).read_to_end(&mut buf).await?;
            serde_json::from_slice(&buf).map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e))
        }

        async fn write_request<T>(
            &mut self,
            _protocol: &Self::Protocol,
            io: &mut T,
            req: Self::Request,
        ) -> io::Result<()>
        where
            T: AsyncWrite + Unpin + Send,
        {
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
        where
            T: AsyncWrite + Unpin + Send,
        {
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

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
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
    #[serde(default)]
    relay_trace_json: String,
}

const PIPELINE_STREAM_PROTOCOL: &str = "/vryx/pipeline/1";
const PIPELINE_FRAME_MAGIC: &[u8; 4] = b"VRYX";
const PIPELINE_FRAME_VERSION: u16 = 1;
const PIPELINE_FRAME_REQUEST: u8 = 1;
const PIPELINE_FRAME_RESPONSE: u8 = 2;
const PIPELINE_FRAME_ERROR: u8 = 255;
const PIPELINE_FRAME_HEADER_LEN: usize = 32;
const PIPELINE_FRAME_MAX_PAYLOAD: u64 = 512 * 1024 * 1024;

#[derive(Debug, Clone)]
struct PipelineFrame {
    frame_type: u8,
    request_id: String,
    session_id: String,
    step_id: u64,
    dtype: String,
    payload: Vec<u8>,
}

#[derive(Debug, Clone, Default)]
struct PipelineStreamTrace {
    stream_open_ms: u64,
    stream_reused: bool,
    stream_send_ms: u64,
    stream_wait_response_ms: u64,
    stream_roundtrip_ms: u64,
    request_response_fallback: bool,
    frames_sent: u64,
    frames_received: u64,
}

#[derive(Clone)]
struct PipelineStreamHandle {
    stream: Arc<tokio::sync::Mutex<libp2p::Stream>>,
    opened_at: Instant,
}

type PipelineStreamCache = Arc<Mutex<HashMap<String, PipelineStreamHandle>>>;
type ChainPendingResults =
    Arc<tokio::sync::Mutex<HashMap<String, tokio::sync::oneshot::Sender<serde_json::Value>>>>;

fn chain_pending_key(session_id: &str, request_id: &str, step_id: u64) -> String {
    format!("{}:{}:{}", session_id, request_id, step_id)
}

fn env_duration_ms(name: &str, default_ms: u64, min_ms: u64, max_ms: u64) -> Duration {
    let value = std::env::var(name)
        .ok()
        .and_then(|v| v.parse::<u64>().ok())
        .unwrap_or(default_ms)
        .clamp(min_ms, max_ms);
    Duration::from_millis(value)
}

fn chain_forward_ack_timeout() -> Duration {
    env_duration_ms("VRYX_CHAIN_FORWARD_ACK_TIMEOUT_MS", 5_000, 500, 60_000)
}

fn chain_result_timeout() -> Duration {
    env_duration_ms("VRYX_CHAIN_RESULT_TIMEOUT_MS", 30_000, 1_000, 300_000)
}

fn chain_total_step_timeout() -> Duration {
    env_duration_ms("VRYX_CHAIN_TOTAL_STEP_TIMEOUT_MS", 60_000, 1_000, 600_000)
}

fn unix_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn env_bool_enabled(name: &str) -> bool {
    std::env::var(name)
        .ok()
        .map(|v| {
            matches!(
                v.trim().to_ascii_lowercase().as_str(),
                "1" | "true" | "yes" | "on"
            )
        })
        .unwrap_or(false)
}

fn pipeline_stream_cache_key(session_id: &str, peer: &PeerId) -> String {
    format!("{}|{}", session_id, peer)
}

fn pipeline_frame_deadline() -> Duration {
    Duration::from_millis(env_u64_clamped(
        "VRYX_PIPELINE_STREAM_FRAME_TIMEOUT_MS",
        300_000,
        1_000,
        900_000,
    ))
}

fn bytes_checksum(data: &[u8]) -> String {
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    data.hash(&mut hasher);
    format!("{:016x}", hasher.finish())
}

fn put_u16(buf: &mut Vec<u8>, value: u16) {
    buf.extend_from_slice(&value.to_be_bytes());
}

fn put_u64(buf: &mut Vec<u8>, value: u64) {
    buf.extend_from_slice(&value.to_be_bytes());
}

fn read_u16(buf: &[u8], offset: usize) -> u16 {
    u16::from_be_bytes([buf[offset], buf[offset + 1]])
}

fn read_u64(buf: &[u8], offset: usize) -> u64 {
    u64::from_be_bytes([
        buf[offset],
        buf[offset + 1],
        buf[offset + 2],
        buf[offset + 3],
        buf[offset + 4],
        buf[offset + 5],
        buf[offset + 6],
        buf[offset + 7],
    ])
}

fn encode_pipeline_frame(frame: &PipelineFrame) -> std::io::Result<Vec<u8>> {
    let request_id = frame.request_id.as_bytes();
    let session_id = frame.session_id.as_bytes();
    let dtype = frame.dtype.as_bytes();
    if request_id.len() > u16::MAX as usize
        || session_id.len() > u16::MAX as usize
        || dtype.len() > u16::MAX as usize
    {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "pipeline frame metadata too large",
        ));
    }
    if frame.payload.len() as u64 > PIPELINE_FRAME_MAX_PAYLOAD {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "pipeline frame payload too large",
        ));
    }
    let mut out = Vec::with_capacity(
        PIPELINE_FRAME_HEADER_LEN
            + request_id.len()
            + session_id.len()
            + dtype.len()
            + frame.payload.len(),
    );
    out.extend_from_slice(PIPELINE_FRAME_MAGIC);
    put_u16(&mut out, PIPELINE_FRAME_VERSION);
    out.push(frame.frame_type);
    out.push(0);
    put_u64(&mut out, frame.step_id);
    put_u16(&mut out, request_id.len() as u16);
    put_u16(&mut out, session_id.len() as u16);
    put_u16(&mut out, dtype.len() as u16);
    put_u16(&mut out, 0);
    put_u64(&mut out, frame.payload.len() as u64);
    out.extend_from_slice(request_id);
    out.extend_from_slice(session_id);
    out.extend_from_slice(dtype);
    out.extend_from_slice(&frame.payload);
    Ok(out)
}

async fn write_pipeline_frame(
    stream: &mut libp2p::Stream,
    frame: &PipelineFrame,
) -> std::io::Result<()> {
    let data = encode_pipeline_frame(frame)?;
    stream.write_all(&data).await?;
    stream.flush().await
}

async fn read_pipeline_frame(stream: &mut libp2p::Stream) -> std::io::Result<PipelineFrame> {
    let mut header = [0u8; PIPELINE_FRAME_HEADER_LEN];
    stream.read_exact(&mut header).await?;
    if &header[0..4] != PIPELINE_FRAME_MAGIC {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "bad pipeline frame magic",
        ));
    }
    let version = read_u16(&header, 4);
    if version != PIPELINE_FRAME_VERSION {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "bad pipeline frame version",
        ));
    }
    let frame_type = header[6];
    let step_id = read_u64(&header, 8);
    let request_len = read_u16(&header, 16) as usize;
    let session_len = read_u16(&header, 18) as usize;
    let dtype_len = read_u16(&header, 20) as usize;
    let payload_len = read_u64(&header, 24);
    if payload_len > PIPELINE_FRAME_MAX_PAYLOAD {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "pipeline frame payload too large",
        ));
    }
    let meta_len = request_len
        .checked_add(session_len)
        .and_then(|v| v.checked_add(dtype_len))
        .ok_or_else(|| {
            std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                "pipeline frame metadata overflow",
            )
        })?;
    let mut meta = vec![0u8; meta_len];
    if meta_len > 0 {
        stream.read_exact(&mut meta).await?;
    }
    let mut payload = vec![0u8; payload_len as usize];
    if payload_len > 0 {
        stream.read_exact(&mut payload).await?;
    }
    let request_end = request_len;
    let session_end = request_end + session_len;
    let dtype_end = session_end + dtype_len;
    let request_id = String::from_utf8(meta[..request_end].to_vec())
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))?;
    let session_id = String::from_utf8(meta[request_end..session_end].to_vec())
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))?;
    let dtype = String::from_utf8(meta[session_end..dtype_end].to_vec())
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))?;
    Ok(PipelineFrame {
        frame_type,
        request_id,
        session_id,
        step_id,
        dtype,
        payload,
    })
}

async fn handle_chain_control_frame(
    peer: PeerId,
    my_peer_id: PeerId,
    frame: PipelineFrame,
    grpc_port: u16,
    stream_control: Arc<tokio::sync::Mutex<libp2p_stream::Control>>,
    stream_cache: PipelineStreamCache,
    stream_ttl: Duration,
) -> (bool, Vec<u8>) {
    use base64::{engine::general_purpose, Engine as _};
    let started = Instant::now();
    let chain_received_ms = unix_ms();
    let mut body = serde_json::from_slice::<serde_json::Value>(&frame.payload)
        .unwrap_or_else(|_| serde_json::json!({}));
    let routing_path: Vec<String> = body
        .get("routing_path")
        .and_then(|r| r.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|x| x.as_str().map(|s| s.to_string()))
                .collect::<Vec<String>>()
        })
        .unwrap_or_default();

    if frame.dtype == "vryx.chain.forward.batch.step" {
        let forward_dtype = body
            .get("forward_dtype")
            .and_then(|v| v.as_str())
            .unwrap_or("vryx.shard.pipeline")
            .to_string();
        let payload_bytes = body
            .get("payload_b64")
            .and_then(|v| v.as_str())
            .and_then(|v| general_purpose::STANDARD.decode(v).ok())
            .unwrap_or_default();
        let compute_started = Instant::now();
        let m4_grpc_compute_start_ms = unix_ms();
        let compute_result = call_local_inference(
            grpc_port,
            payload_bytes,
            forward_dtype.clone(),
            Vec::new(),
            frame.session_id.clone(),
        )
        .await;
        let m4_grpc_compute_end_ms = unix_ms();
        return match compute_result {
            Ok((data, c, ser, metrics, c_ms)) => {
                let response = TensorResponse {
                    data,
                    compute_time_ns: c,
                    serialization_time_ns: ser,
                    prompt_tokens_llm: metrics.prompt_tokens,
                    completion_tokens_llm: metrics.completion_tokens,
                    total_tokens_llm: metrics.total_tokens,
                    vps_delegate_ms: compute_started.elapsed().as_millis() as u64,
                    worker_compute_ms: c_ms,
                    shard_session_id: metrics.shard_session_id,
                    compute_time_ms: c_ms,
                    relay_trace_json: serde_json::json!({
                        "transport": "pipeline_stream_chain_batch_step",
                        "worker_seen_request": true,
                        "worker_compute_ms": c_ms,
                        "chain_type": "CHAIN_BATCH_STEP_RESULT",
                        "m4_chain_received_ms": chain_received_ms,
                        "m4_grpc_compute_start_ms": m4_grpc_compute_start_ms,
                        "m4_grpc_compute_end_ms": m4_grpc_compute_end_ms,
                    })
                    .to_string(),
                    ..Default::default()
                };
                (true, serde_json::to_vec(&response).unwrap_or_default())
            }
            Err(e) => (
                false,
                serde_json::json!({
                    "ok": false,
                    "chain_type": "CHAIN_BATCH_ERROR",
                    "error": format!("chain_batch_step_compute_failed: {}", e),
                    "m4_chain_received_ms": chain_received_ms,
                    "m4_grpc_compute_start_ms": m4_grpc_compute_start_ms,
                    "m4_grpc_compute_end_ms": m4_grpc_compute_end_ms,
                })
                .to_string()
                .into_bytes(),
            ),
        };
    }

    if frame.dtype == "vryx.chain.forward.batch" {
        let result_peer_str = body
            .get("result_peer")
            .and_then(|v| v.as_str())
            .map(|v| v.to_string())
            .unwrap_or_else(|| peer.to_string());
        let result_peer = match PeerId::from_str(&result_peer_str) {
            Ok(peer) => peer,
            Err(e) => {
                return (
                    false,
                    serde_json::json!({
                        "ok": false,
                        "chain_type": "CHAIN_BATCH_ERROR",
                        "error": format!("bad_result_peer: {}", e),
                    })
                    .to_string()
                    .into_bytes(),
                );
            }
        };
        let Some(next_peer_str) = routing_path.first() else {
            return (
                false,
                serde_json::json!({
                    "ok": false,
                    "chain_type": "CHAIN_BATCH_ERROR",
                    "error": "chain_batch_missing_next_peer",
                })
                .to_string()
                .into_bytes(),
            );
        };
        let next_peer = match PeerId::from_str(next_peer_str) {
            Ok(peer) => peer,
            Err(e) => {
                return (
                    false,
                    serde_json::json!({
                        "ok": false,
                        "chain_type": "CHAIN_BATCH_ERROR",
                        "error": format!("bad_next_peer: {}", e),
                    })
                    .to_string()
                    .into_bytes(),
                );
            }
        };
        let forward_dtype = body
            .get("forward_dtype")
            .and_then(|v| v.as_str())
            .unwrap_or("vryx.shard.pipeline")
            .to_string();
        let initial_payload_bytes = body
            .get("payload_b64")
            .and_then(|v| v.as_str())
            .and_then(|v| general_purpose::STANDARD.decode(v).ok())
            .unwrap_or_default();
        let token_count = body
            .get("token_count")
            .and_then(|v| v.as_u64().or_else(|| v.as_i64().and_then(|i| if i > 0 { Some(i as u64) } else { None })))
            .unwrap_or(1)
            .min(64) as usize;
        let token_start = body
            .get("token_start")
            .and_then(|v| v.as_u64())
            .unwrap_or(0);
        let microbatch_id = body
            .get("microbatch_id")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        let request_id = frame.request_id.clone();
        let session_id = frame.session_id.clone();
        let base_step = frame.step_id;
        let control_for_task = Arc::clone(&stream_control);
        let cache_for_task = Arc::clone(&stream_cache);
        let stream_ttl_for_task = stream_ttl;
        let result_peer_for_task = result_peer.clone();
        let next_peer_for_task = next_peer.clone();
        let next_peer_for_ack = next_peer.to_string();
        let forward_dtype_for_ack = forward_dtype.clone();
        let microbatch_id_for_ack = microbatch_id.clone();
        let final_peer_for_task = next_peer.to_string();
        let my_peer_for_task = my_peer_id.to_string();
        let body_for_task = body.clone();
        tokio::spawn(async move {
            let batch_started = Instant::now();
            let initial_payload_value = serde_json::from_slice::<serde_json::Value>(&initial_payload_bytes)
                .unwrap_or_else(|_| serde_json::json!({}));
            let mut seed_ids: Vec<i64> = initial_payload_value
                .get("history_token_ids")
                .and_then(|v| v.as_array())
                .map(|arr| arr.iter().filter_map(|x| x.as_i64().or_else(|| x.as_u64().map(|u| u as i64))).collect())
                .unwrap_or_default();
            if seed_ids.is_empty() {
                seed_ids = initial_payload_value
                    .get("token_ids")
                    .and_then(|v| v.as_array())
                    .map(|arr| arr.iter().filter_map(|x| x.as_i64().or_else(|| x.as_u64().map(|u| u as i64))).collect())
                    .unwrap_or_default();
            }
            let stop_ids: HashSet<i64> = initial_payload_value
                .get("stop_token_ids")
                .and_then(|v| v.as_array())
                .map(|arr| arr.iter().filter_map(|x| x.as_i64().or_else(|| x.as_u64().map(|u| u as i64))).collect())
                .unwrap_or_default();
            let eos_id = initial_payload_value
                .get("eos_token_id")
                .and_then(|v| v.as_i64().or_else(|| v.as_u64().map(|u| u as i64)));
            let mut emitted: Vec<i64> = Vec::new();
            let mut current_payload_bytes = initial_payload_bytes.clone();
            let mut last_response_value = serde_json::json!({});
            let mut last_tensor_response: Option<TensorResponse> = None;
            let mut batch_error: Option<String> = None;
            let mut batch_m1_compute_ms = 0u64;
            let mut batch_m4_compute_ms = 0u64;
            let mut batch_result_wait_ms = 0u64;
            let mut internal_frames_sent = 0u64;
            let mut internal_frames_received = 0u64;
            for token_index in 0..token_count {
                let m1_started = Instant::now();
                let m1_result = tokio::time::timeout(
                    chain_total_step_timeout(),
                    call_local_inference(
                        grpc_port,
                        current_payload_bytes.clone(),
                        forward_dtype.clone(),
                        Vec::new(),
                        session_id.clone(),
                    ),
                )
                .await;
                let m1_payload = match m1_result {
                    Ok(Ok((data, _c, _s, _metrics, c_ms))) => {
                        batch_m1_compute_ms = batch_m1_compute_ms
                            .saturating_add(c_ms.max(m1_started.elapsed().as_millis() as u64));
                        data
                    }
                    Ok(Err(e)) => {
                        batch_error = Some(format!("chain_batch_m1_compute_failed: {}", e));
                        break;
                    }
                    Err(_) => {
                        batch_error = Some("chain_batch_m1_compute_timeout".to_string());
                        break;
                    }
                };
                let step_body = serde_json::json!({
                    "chain_type": "CHAIN_FORWARD_BATCH_STEP",
                    "forward_dtype": forward_dtype,
                    "payload_b64": general_purpose::STANDARD.encode(&m1_payload),
                    "payload_len": m1_payload.len(),
                    "microbatch_id": microbatch_id,
                    "token_index": token_index,
                    "token_start": token_start,
                    "token_count": token_count,
                    "source_peer": my_peer_for_task,
                    "final_peer": final_peer_for_task,
                    "m1_chain_received_ms": chain_received_ms,
                });
                let step_frame = PipelineFrame {
                    frame_type: PIPELINE_FRAME_REQUEST,
                    request_id: format!("{}:batch:{}", request_id, token_index),
                    session_id: session_id.clone(),
                    step_id: base_step + token_index as u64,
                    dtype: "vryx.chain.forward.batch.step".to_string(),
                    payload: serde_json::to_vec(&step_body).unwrap_or_default(),
                };
                let wait_started = Instant::now();
                let step_result = tokio::time::timeout(
                    chain_total_step_timeout(),
                    pipeline_stream_roundtrip(
                        Arc::clone(&control_for_task),
                        Arc::clone(&cache_for_task),
                        next_peer_for_task.clone(),
                        step_frame,
                        stream_ttl_for_task,
                    ),
                )
                .await;
                batch_result_wait_ms = batch_result_wait_ms.saturating_add(wait_started.elapsed().as_millis() as u64);
                let step_response_frame = match step_result {
                    Ok(Ok((response, trace))) => {
                        internal_frames_sent = internal_frames_sent.saturating_add(trace.frames_sent);
                        internal_frames_received = internal_frames_received.saturating_add(trace.frames_received);
                        response
                    }
                    Ok(Err(e)) => {
                        batch_error = Some(format!("chain_batch_m4_step_failed: {}", e));
                        break;
                    }
                    Err(_) => {
                        batch_error = Some("chain_batch_m4_step_timeout".to_string());
                        break;
                    }
                };
                let tensor_response = match serde_json::from_slice::<TensorResponse>(&step_response_frame.payload) {
                    Ok(resp) => resp,
                    Err(e) => {
                        batch_error = Some(format!("chain_batch_m4_tensor_decode_failed: {}", e));
                        break;
                    }
                };
                batch_m4_compute_ms = batch_m4_compute_ms.saturating_add(tensor_response.worker_compute_ms);
                let response_value = match serde_json::from_slice::<serde_json::Value>(&tensor_response.data) {
                    Ok(value) => value,
                    Err(e) => {
                        batch_error = Some(format!("chain_batch_m4_payload_decode_failed: {}", e));
                        break;
                    }
                };
                let Some(token_id) = response_value
                    .get("next_token_id")
                    .and_then(|v| v.as_i64().or_else(|| v.as_u64().map(|u| u as i64))) else {
                    batch_error = Some("chain_batch_missing_next_token_id".to_string());
                    break;
                };
                emitted.push(token_id);
                last_response_value = response_value.clone();
                last_tensor_response = Some(tensor_response);
                if eos_id == Some(token_id) || stop_ids.contains(&token_id) {
                    break;
                }
                if token_index + 1 >= token_count {
                    break;
                }
                let mut history_ids = seed_ids.clone();
                history_ids.extend(emitted.iter().copied());
                let mut next_payload = initial_payload_value.clone();
                if let Some(obj) = next_payload.as_object_mut() {
                    obj.insert("token_ids".to_string(), serde_json::json!([token_id]));
                    obj.insert("history_token_ids".to_string(), serde_json::json!(history_ids));
                    obj.insert("step".to_string(), serde_json::json!(base_step + token_index as u64 + 1));
                    obj.insert("seq_pos".to_string(), serde_json::json!(seed_ids.len() + emitted.len() - 1));
                    obj.insert("decode_mode".to_string(), serde_json::json!("single_token_stateful"));
                    obj.insert("stateful_required".to_string(), serde_json::json!(true));
                    obj.insert("use_kv_cache".to_string(), serde_json::json!(true));
                    obj.insert("micro_decode_budget".to_string(), serde_json::json!(1));
                    obj.insert("chain_coalesced_decode".to_string(), serde_json::json!(true));
                }
                current_payload_bytes = serde_json::to_vec(&next_payload).unwrap_or_default();
            }
            let accepted = emitted.len();
            let result_body = if let Some(error) = batch_error {
                serde_json::json!({
                    "ok": false,
                    "chain_type": "CHAIN_BATCH_ERROR",
                    "session_id": session_id,
                    "request_id": request_id,
                    "step_id": base_step,
                    "microbatch_id": microbatch_id,
                    "from_peer": final_peer_for_task,
                    "final_peer": final_peer_for_task,
                    "dtype": forward_dtype,
                    "payload_len": 0,
                    "error": error,
                    "token_start": token_start,
                    "token_count": token_count,
                    "accepted_token_count": accepted,
                    "batch_m1_compute_ms": batch_m1_compute_ms,
                    "batch_m4_compute_ms": batch_m4_compute_ms,
                    "batch_result_wait_ms": batch_result_wait_ms,
                    "m1_chain_received_ms": chain_received_ms,
                    "m4_chain_result_send_ms": unix_ms(),
                })
            } else if accepted == 0 {
                serde_json::json!({
                    "ok": false,
                    "chain_type": "CHAIN_BATCH_ERROR",
                    "session_id": session_id,
                    "request_id": request_id,
                    "step_id": base_step,
                    "microbatch_id": microbatch_id,
                    "from_peer": final_peer_for_task,
                    "final_peer": final_peer_for_task,
                    "dtype": forward_dtype,
                    "payload_len": 0,
                    "error": "chain_batch_empty_result",
                    "token_start": token_start,
                    "token_count": token_count,
                    "accepted_token_count": 0,
                    "m4_chain_result_send_ms": unix_ms(),
                })
            } else {
                let mut final_value = last_response_value.clone();
                if let Some(obj) = final_value.as_object_mut() {
                    obj.insert("candidate_token_ids".to_string(), serde_json::json!(emitted));
                    obj.insert("accepted_token_count".to_string(), serde_json::json!(accepted));
                    obj.insert("next_token_id".to_string(), serde_json::json!(emitted[accepted - 1]));
                    obj.insert("decode_microbatch".to_string(), serde_json::json!(accepted > 1));
                    obj.insert("speculative_method".to_string(), serde_json::json!("pipeline_chain_coalesced_greedy"));
                    obj.insert("speculative_available".to_string(), serde_json::json!(accepted > 1));
                    obj.insert("transport_trace".to_string(), serde_json::json!({
                        "transport": "pipeline_stream_chain_batch_direct",
                        "worker_seen_request": true,
                        "chain_result_direct": true,
                        "chain_type": "CHAIN_BATCH_RESULT",
                        "coalesced": true,
                        "microbatch_id": microbatch_id,
                        "token_start": token_start,
                        "token_count": accepted,
                        "batch_hop_count": 1,
                        "chain_hop_count": 1,
                        "batch_m1_compute_ms": batch_m1_compute_ms,
                        "batch_m4_compute_ms": batch_m4_compute_ms,
                        "batch_result_wait_ms": batch_result_wait_ms,
                        "batch_tokens_per_second": if batch_started.elapsed().as_millis() > 0 { (accepted as f64 * 1000.0) / batch_started.elapsed().as_millis() as f64 } else { 0.0 },
                    }));
                }
                let mut response = last_tensor_response.unwrap_or_default();
                response.data = serde_json::to_vec(&final_value).unwrap_or_default();
                response.worker_compute_ms = batch_m4_compute_ms;
                response.compute_time_ms = batch_m4_compute_ms;
                response.relay_trace_json = serde_json::json!({
                    "transport": "pipeline_stream_chain_batch_direct",
                    "worker_seen_request": true,
                    "chain_result_direct": true,
                    "chain_result_from_peer": final_peer_for_task,
                    "chain_type": "CHAIN_BATCH_RESULT",
                    "coalesced": true,
                    "microbatch_id": microbatch_id,
                    "token_start": token_start,
                    "token_count": accepted,
                    "batch_hop_count": 1,
                    "chain_hop_count": 1,
                    "batch_m1_compute_ms": batch_m1_compute_ms,
                    "batch_m4_compute_ms": batch_m4_compute_ms,
                    "batch_result_wait_ms": batch_result_wait_ms,
                    "batch_tokens_per_second": if batch_started.elapsed().as_millis() > 0 { (accepted as f64 * 1000.0) / batch_started.elapsed().as_millis() as f64 } else { 0.0 },
                })
                .to_string();
                let payload = serde_json::to_vec(&response).unwrap_or_default();
                serde_json::json!({
                    "ok": true,
                    "chain_type": "CHAIN_BATCH_RESULT",
                    "session_id": session_id,
                    "request_id": request_id,
                    "step_id": base_step,
                    "microbatch_id": microbatch_id,
                    "from_peer": final_peer_for_task,
                    "final_peer": final_peer_for_task,
                    "dtype": forward_dtype,
                    "payload_len": payload.len(),
                    "payload_b64": general_purpose::STANDARD.encode(&payload),
                    "token_start": token_start,
                    "token_count": accepted,
                    "accepted_token_count": accepted,
                    "coalesced": true,
                    "batch_hop_count": 1,
                    "chain_hop_count": 1,
                    "batch_m1_compute_ms": batch_m1_compute_ms,
                    "batch_m4_compute_ms": batch_m4_compute_ms,
                    "batch_result_wait_ms": batch_result_wait_ms,
                    "batch_tokens_per_second": if batch_started.elapsed().as_millis() > 0 { (accepted as f64 * 1000.0) / batch_started.elapsed().as_millis() as f64 } else { 0.0 },
                    "internal_frames_sent": internal_frames_sent,
                    "internal_frames_received": internal_frames_received,
                    "m1_chain_received_ms": chain_received_ms,
                    "m4_chain_result_send_ms": unix_ms(),
                })
            };
            let result_frame = PipelineFrame {
                frame_type: PIPELINE_FRAME_REQUEST,
                request_id: result_body
                    .get("request_id")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string(),
                session_id: result_body
                    .get("session_id")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string(),
                step_id: base_step,
                dtype: "vryx.chain.result".to_string(),
                payload: serde_json::to_vec(&result_body).unwrap_or_default(),
            };
            if let Err(e) = pipeline_stream_roundtrip(
                control_for_task,
                cache_for_task,
                result_peer_for_task,
                result_frame,
                stream_ttl_for_task,
            )
            .await
            {
                eprintln!("[CHAIN_BATCH_RESULT] envoi direct échoué : {}", e);
            }
            let _ = body_for_task;
        });
        return (
            true,
            serde_json::json!({
                "ok": true,
                "chain_type": "CHAIN_FORWARD_ACK",
                "chain_batch": true,
                "request_id": frame.request_id,
                "session_id": frame.session_id,
                "step_id": frame.step_id,
                "microbatch_id": microbatch_id_for_ack,
                "from_peer": my_peer_id.to_string(),
                "final_peer": next_peer_for_ack,
                "result_peer": result_peer_str,
                "dtype": forward_dtype_for_ack,
                "token_start": token_start,
                "token_count": token_count,
                "latency_ms": started.elapsed().as_millis() as u64,
            })
            .to_string()
            .into_bytes(),
        );
    }

    if frame.dtype == "vryx.chain.forward" {
        let result_peer_str = body
            .get("result_peer")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string())
            .unwrap_or_else(|| peer.to_string());
        if let Some(obj) = body.as_object_mut() {
            obj.entry("result_peer".to_string())
                .or_insert_with(|| serde_json::json!(result_peer_str.clone()));
            obj.entry("source_peer".to_string())
                .or_insert_with(|| serde_json::json!(peer.to_string()));
        }
        if let Some(next_peer_str) = routing_path.first() {
            let next_peer = match PeerId::from_str(next_peer_str) {
                Ok(peer) => peer,
                Err(e) => {
                    return (
                        false,
                        serde_json::json!({
                            "ok": false,
                            "chain_type": "CHAIN_ERROR",
                            "error": format!("bad_next_peer: {}", e),
                        })
                        .to_string()
                        .into_bytes(),
                    );
                }
            };
            let forward_dtype = body
                .get("forward_dtype")
                .and_then(|v| v.as_str())
                .unwrap_or("vryx.shard.pipeline")
                .to_string();
            let current_payload = body
                .get("payload_b64")
                .and_then(|v| v.as_str())
                .and_then(|s| general_purpose::STANDARD.decode(s).ok())
                .unwrap_or_default();
            let mut m1_grpc_compute_start_ms = 0u64;
            let mut m1_grpc_compute_end_ms = 0u64;
            let next_payload = if forward_dtype.starts_with("vryx.chain.fake_tensor") {
                current_payload
            } else {
                m1_grpc_compute_start_ms = unix_ms();
                let compute_result = tokio::time::timeout(
                    chain_total_step_timeout(),
                    call_local_inference(
                        grpc_port,
                        current_payload,
                        forward_dtype.clone(),
                        Vec::new(),
                        frame.session_id.clone(),
                    ),
                )
                .await;
                m1_grpc_compute_end_ms = unix_ms();
                match compute_result {
                    Ok(Ok((data, _c, _s, _metrics, _c_ms))) => data,
                    Ok(Err(e)) => {
                        return (
                            false,
                            serde_json::json!({
                                "ok": false,
                                "chain_type": "CHAIN_ERROR",
                                "error": format!("chain_forward_local_compute_failed: {}", e),
                                "latency_ms": started.elapsed().as_millis() as u64,
                            })
                            .to_string()
                            .into_bytes(),
                        );
                    }
                    Err(_) => {
                        return (
                            false,
                            serde_json::json!({
                                "ok": false,
                                "chain_type": "CHAIN_ERROR",
                                "error": "chain_forward_local_compute_timeout",
                                "latency_ms": started.elapsed().as_millis() as u64,
                            })
                            .to_string()
                            .into_bytes(),
                        );
                    }
                }
            };
            if env_bool_enabled("VRYX_CHAIN_CAPTURE_M1_OUTPUT") {
                let capture_dir =
                    std::env::var("VRYX_CHAIN_CAPTURE_DIR").unwrap_or_else(|_| "/tmp".to_string());
                let safe_key = format!(
                    "{}-{}-{}",
                    frame.session_id.replace('/', "_"),
                    frame.request_id.replace('/', "_"),
                    frame.step_id
                );
                let capture_path = std::path::Path::new(&capture_dir)
                    .join(format!("vryx-chain-m1-output-{}.json", safe_key));
                let capture = serde_json::json!({
                    "ok": true,
                    "session_id": frame.session_id,
                    "request_id": frame.request_id,
                    "step_id": frame.step_id,
                    "forward_dtype": forward_dtype,
                    "source_peer": my_peer_id.to_string(),
                    "target_peer": next_peer.to_string(),
                    "payload_len": next_payload.len(),
                    "payload_b64": general_purpose::STANDARD.encode(&next_payload),
                    "m1_chain_received_ms": chain_received_ms,
                    "m1_grpc_compute_start_ms": m1_grpc_compute_start_ms,
                    "m1_grpc_compute_end_ms": m1_grpc_compute_end_ms,
                });
                if let Err(e) = std::fs::write(&capture_path, capture.to_string()) {
                    eprintln!(
                        "[CHAIN_CAPTURE] écriture impossible {} : {}",
                        capture_path.display(),
                        e
                    );
                } else {
                    println!("[CHAIN_CAPTURE] M1 output saved {}", capture_path.display());
                }
            }
            let m1_forward_to_m4_start_ms = unix_ms();
            if let Some(obj) = body.as_object_mut() {
                obj.insert(
                    "routing_path".to_string(),
                    serde_json::json!(routing_path[1..].to_vec()),
                );
                obj.insert(
                    "payload_b64".to_string(),
                    serde_json::json!(general_purpose::STANDARD.encode(&next_payload)),
                );
                obj.insert(
                    "payload_len".to_string(),
                    serde_json::json!(next_payload.len()),
                );
                obj.insert(
                    "upstream_peer".to_string(),
                    serde_json::json!(my_peer_id.to_string()),
                );
                obj.insert(
                    "upstream_compute_ms".to_string(),
                    serde_json::json!(started.elapsed().as_millis() as u64),
                );
                obj.insert(
                    "m1_chain_received_ms".to_string(),
                    serde_json::json!(chain_received_ms),
                );
                obj.insert(
                    "m1_grpc_compute_start_ms".to_string(),
                    serde_json::json!(m1_grpc_compute_start_ms),
                );
                obj.insert(
                    "m1_grpc_compute_end_ms".to_string(),
                    serde_json::json!(m1_grpc_compute_end_ms),
                );
                obj.insert(
                    "m1_forward_to_m4_start_ms".to_string(),
                    serde_json::json!(m1_forward_to_m4_start_ms),
                );
            }
            let payload = serde_json::to_vec(&body).unwrap_or_else(|_| frame.payload.clone());
            let next_frame = PipelineFrame {
                frame_type: PIPELINE_FRAME_REQUEST,
                request_id: frame.request_id.clone(),
                session_id: frame.session_id.clone(),
                step_id: frame.step_id,
                dtype: frame.dtype.clone(),
                payload,
            };
            return match tokio::time::timeout(
                chain_forward_ack_timeout(),
                pipeline_stream_roundtrip(
                    stream_control,
                    stream_cache,
                    next_peer,
                    next_frame,
                    stream_ttl,
                ),
            )
            .await
            {
                Ok(Ok((response, trace))) => {
                    let mut value = serde_json::from_slice::<serde_json::Value>(&response.payload)
                        .unwrap_or_else(|_| serde_json::json!({"ok": false, "chain_type": "CHAIN_ERROR", "error": "bad_downstream_ack_json"}));
                    if let Some(obj) = value.as_object_mut() {
                        obj.insert("chain_forwarded".to_string(), serde_json::json!(true));
                        obj.insert(
                            "chain_ack_ms".to_string(),
                            serde_json::json!(trace.stream_roundtrip_ms),
                        );
                        obj.insert(
                            "m1_chain_received_ms".to_string(),
                            serde_json::json!(chain_received_ms),
                        );
                        obj.insert(
                            "m1_grpc_compute_start_ms".to_string(),
                            serde_json::json!(m1_grpc_compute_start_ms),
                        );
                        obj.insert(
                            "m1_grpc_compute_end_ms".to_string(),
                            serde_json::json!(m1_grpc_compute_end_ms),
                        );
                        obj.insert(
                            "m1_forward_to_m4_ms".to_string(),
                            serde_json::json!(unix_ms().saturating_sub(m1_forward_to_m4_start_ms)),
                        );
                        obj.insert(
                            "chain_reused".to_string(),
                            serde_json::json!(trace.stream_reused),
                        );
                    }
                    (
                        value.get("ok").and_then(|v| v.as_bool()).unwrap_or(false),
                        value.to_string().into_bytes(),
                    )
                }
                Ok(Err(e)) => (
                    false,
                    serde_json::json!({
                        "ok": false,
                        "chain_type": "CHAIN_ERROR",
                        "error": e,
                        "latency_ms": started.elapsed().as_millis() as u64,
                    })
                    .to_string()
                    .into_bytes(),
                ),
                Err(_) => (
                    false,
                    serde_json::json!({
                        "ok": false,
                        "chain_type": "CHAIN_ERROR",
                        "error": "chain_forward_ack_timeout",
                        "latency_ms": started.elapsed().as_millis() as u64,
                    })
                    .to_string()
                    .into_bytes(),
                ),
            };
        }

        let result_peer = match PeerId::from_str(&result_peer_str) {
            Ok(peer) => peer,
            Err(e) => {
                return (
                    false,
                    serde_json::json!({
                        "ok": false,
                        "chain_type": "CHAIN_ERROR",
                        "error": format!("bad_result_peer: {}", e),
                    })
                    .to_string()
                    .into_bytes(),
                );
            }
        };
        let forward_dtype = body
            .get("forward_dtype")
            .and_then(|v| v.as_str())
            .unwrap_or("vryx.shard.pipeline")
            .to_string();
        let payload_bytes = body
            .get("payload_b64")
            .and_then(|v| v.as_str())
            .and_then(|s| general_purpose::STANDARD.decode(s).ok())
            .unwrap_or_default();
        let request_id = frame.request_id.clone();
        let session_id = frame.session_id.clone();
        let step_id = frame.step_id;
        let final_peer = body
            .get("final_peer")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string())
            .unwrap_or_else(|| my_peer_id.to_string());
        let control_for_result = Arc::clone(&stream_control);
        let cache_for_result = Arc::clone(&stream_cache);
        let forward_dtype_for_ack = forward_dtype.clone();
        let final_peer_for_ack = final_peer.clone();
        let m4_chain_received_ms = chain_received_ms;
        let inbound_trace = body.clone();
        tokio::spawn(async move {
            let compute_started = Instant::now();
            let mut m4_grpc_compute_start_ms = 0u64;
            let mut m4_grpc_compute_end_ms = 0u64;
            let result_body = if forward_dtype.starts_with("vryx.chain.fake_tensor") {
                serde_json::json!({
                    "ok": true,
                    "chain_type": "CHAIN_RESULT",
                    "session_id": session_id,
                    "request_id": request_id,
                    "step_id": step_id,
                    "from_peer": final_peer,
                    "final_peer": final_peer,
                    "dtype": forward_dtype,
                    "payload_len": payload_bytes.len(),
                    "payload_b64": general_purpose::STANDARD.encode(&payload_bytes),
                    "checksum": bytes_checksum(&payload_bytes),
                    "is_fake_tensor": true,
                    "compute_ms": compute_started.elapsed().as_millis() as u64,
                    "m1_chain_received_ms": inbound_trace.get("m1_chain_received_ms").cloned().unwrap_or(serde_json::Value::Null),
                    "m1_grpc_compute_start_ms": inbound_trace.get("m1_grpc_compute_start_ms").cloned().unwrap_or(serde_json::Value::Null),
                    "m1_grpc_compute_end_ms": inbound_trace.get("m1_grpc_compute_end_ms").cloned().unwrap_or(serde_json::Value::Null),
                    "m1_forward_to_m4_start_ms": inbound_trace.get("m1_forward_to_m4_start_ms").cloned().unwrap_or(serde_json::Value::Null),
                    "m4_chain_received_ms": m4_chain_received_ms,
                    "m4_grpc_compute_start_ms": m4_grpc_compute_start_ms,
                    "m4_grpc_compute_end_ms": m4_grpc_compute_end_ms,
                    "m4_chain_result_send_ms": unix_ms(),
                })
            } else if env_bool_enabled("VRYX_CHAIN_M4_FAKE_COMPUTE") {
                let fake_response = TensorResponse {
                    data: serde_json::json!({
                        "ok": true,
                        "chain_m4_fake_compute": true,
                        "decode_mode": "chain_m4_fake_compute",
                        "next_token_id": 0,
                        "candidate_token_ids": [0],
                        "accepted_token_count": 1,
                    })
                    .to_string()
                    .into_bytes(),
                    compute_time_ms: 0,
                    worker_compute_ms: 0,
                    relay_trace_json: serde_json::json!({
                        "transport": "pipeline_stream_chain_result_direct",
                        "worker_seen_request": true,
                        "worker_compute_ms": 0,
                        "chain_result_direct": true,
                        "chain_result_from_peer": final_peer,
                        "chain_m4_fake_compute": true,
                    })
                    .to_string(),
                    ..Default::default()
                };
                let payload = serde_json::to_vec(&fake_response).unwrap_or_default();
                serde_json::json!({
                    "ok": true,
                    "chain_type": "CHAIN_RESULT",
                    "session_id": session_id,
                    "request_id": request_id,
                    "step_id": step_id,
                    "from_peer": final_peer,
                    "final_peer": final_peer,
                    "dtype": forward_dtype,
                    "payload_len": payload.len(),
                    "payload_b64": general_purpose::STANDARD.encode(&payload),
                    "compute_ms": 0,
                    "chain_m4_fake_compute": true,
                    "m1_chain_received_ms": inbound_trace.get("m1_chain_received_ms").cloned().unwrap_or(serde_json::Value::Null),
                    "m1_grpc_compute_start_ms": inbound_trace.get("m1_grpc_compute_start_ms").cloned().unwrap_or(serde_json::Value::Null),
                    "m1_grpc_compute_end_ms": inbound_trace.get("m1_grpc_compute_end_ms").cloned().unwrap_or(serde_json::Value::Null),
                    "m1_forward_to_m4_start_ms": inbound_trace.get("m1_forward_to_m4_start_ms").cloned().unwrap_or(serde_json::Value::Null),
                    "m4_chain_received_ms": m4_chain_received_ms,
                    "m4_grpc_compute_start_ms": m4_grpc_compute_start_ms,
                    "m4_grpc_compute_end_ms": m4_grpc_compute_end_ms,
                    "m4_chain_result_send_ms": unix_ms(),
                })
            } else {
                m4_grpc_compute_start_ms = unix_ms();
                let compute_result = call_local_inference(
                    grpc_port,
                    payload_bytes,
                    forward_dtype.clone(),
                    Vec::new(),
                    session_id.clone(),
                )
                .await;
                m4_grpc_compute_end_ms = unix_ms();
                match compute_result {
                    Ok((data, c, s, metrics, c_ms)) => {
                        let response = TensorResponse {
                            data,
                            compute_time_ns: c,
                            serialization_time_ns: s,
                            prompt_tokens_llm: metrics.prompt_tokens,
                            completion_tokens_llm: metrics.completion_tokens,
                            total_tokens_llm: metrics.total_tokens,
                            vps_delegate_ms: compute_started.elapsed().as_millis() as u64,
                            worker_compute_ms: c_ms,
                            p2p_messages_in: 0,
                            p2p_messages_out: 0,
                            shard_session_id: metrics.shard_session_id,
                            scheduler_workers_used: 0,
                            shard_warmup_sent: 0,
                            compute_time_ms: c_ms,
                            relay_trace_json: serde_json::json!({
                                "transport": "pipeline_stream_chain_result_direct",
                                "worker_seen_request": true,
                                "worker_compute_ms": c_ms,
                                "chain_result_direct": true,
                                "chain_result_from_peer": final_peer,
                                "m1_chain_received_ms": inbound_trace.get("m1_chain_received_ms").cloned().unwrap_or(serde_json::Value::Null),
                                "m1_grpc_compute_start_ms": inbound_trace.get("m1_grpc_compute_start_ms").cloned().unwrap_or(serde_json::Value::Null),
                                "m1_grpc_compute_end_ms": inbound_trace.get("m1_grpc_compute_end_ms").cloned().unwrap_or(serde_json::Value::Null),
                                "m1_forward_to_m4_start_ms": inbound_trace.get("m1_forward_to_m4_start_ms").cloned().unwrap_or(serde_json::Value::Null),
                                "m4_chain_received_ms": m4_chain_received_ms,
                                "m4_grpc_compute_start_ms": m4_grpc_compute_start_ms,
                                "m4_grpc_compute_end_ms": m4_grpc_compute_end_ms,
                            })
                            .to_string(),
                        };
                        let payload = serde_json::to_vec(&response).unwrap_or_default();
                        serde_json::json!({
                            "ok": true,
                            "chain_type": "CHAIN_RESULT",
                            "session_id": session_id,
                            "request_id": request_id,
                            "step_id": step_id,
                            "from_peer": final_peer,
                            "final_peer": final_peer,
                            "dtype": forward_dtype,
                            "payload_len": payload.len(),
                            "payload_b64": general_purpose::STANDARD.encode(&payload),
                            "compute_ms": c_ms,
                            "m1_chain_received_ms": inbound_trace.get("m1_chain_received_ms").cloned().unwrap_or(serde_json::Value::Null),
                            "m1_grpc_compute_start_ms": inbound_trace.get("m1_grpc_compute_start_ms").cloned().unwrap_or(serde_json::Value::Null),
                            "m1_grpc_compute_end_ms": inbound_trace.get("m1_grpc_compute_end_ms").cloned().unwrap_or(serde_json::Value::Null),
                            "m1_forward_to_m4_start_ms": inbound_trace.get("m1_forward_to_m4_start_ms").cloned().unwrap_or(serde_json::Value::Null),
                            "m4_chain_received_ms": m4_chain_received_ms,
                            "m4_grpc_compute_start_ms": m4_grpc_compute_start_ms,
                            "m4_grpc_compute_end_ms": m4_grpc_compute_end_ms,
                            "m4_chain_result_send_ms": unix_ms(),
                        })
                    }
                    Err(e) => serde_json::json!({
                        "ok": false,
                        "chain_type": "CHAIN_RESULT",
                        "session_id": session_id,
                        "request_id": request_id,
                        "step_id": step_id,
                        "from_peer": final_peer,
                        "final_peer": final_peer,
                        "dtype": forward_dtype,
                        "payload_len": 0,
                        "error": format!("chain_result_compute_failed: {}", e),
                        "m1_chain_received_ms": inbound_trace.get("m1_chain_received_ms").cloned().unwrap_or(serde_json::Value::Null),
                        "m1_grpc_compute_start_ms": inbound_trace.get("m1_grpc_compute_start_ms").cloned().unwrap_or(serde_json::Value::Null),
                        "m1_grpc_compute_end_ms": inbound_trace.get("m1_grpc_compute_end_ms").cloned().unwrap_or(serde_json::Value::Null),
                        "m4_chain_received_ms": m4_chain_received_ms,
                        "m4_grpc_compute_start_ms": m4_grpc_compute_start_ms,
                        "m4_grpc_compute_end_ms": m4_grpc_compute_end_ms,
                        "m4_chain_result_send_ms": unix_ms(),
                    }),
                }
            };
            let result_frame = PipelineFrame {
                frame_type: PIPELINE_FRAME_REQUEST,
                request_id: result_body
                    .get("request_id")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string(),
                session_id: result_body
                    .get("session_id")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string(),
                step_id,
                dtype: "vryx.chain.result".to_string(),
                payload: serde_json::to_vec(&result_body).unwrap_or_default(),
            };
            if let Err(e) = pipeline_stream_roundtrip(
                control_for_result,
                cache_for_result,
                result_peer,
                result_frame,
                stream_ttl,
            )
            .await
            {
                eprintln!(
                    "[CHAIN_RESULT] envoi direct échoué vers {} : {}",
                    result_peer, e
                );
            }
        });
        return (
            true,
            serde_json::json!({
                "ok": true,
                "chain_type": "CHAIN_FORWARD_ACK",
                "request_id": frame.request_id,
                "session_id": frame.session_id,
                "step_id": frame.step_id,
                "from_peer": my_peer_id.to_string(),
                "final_peer": final_peer_for_ack,
                "result_peer": result_peer_str,
                "dtype": forward_dtype_for_ack,
                "latency_ms": started.elapsed().as_millis() as u64,
            })
            .to_string()
            .into_bytes(),
        );
    }

    if let Some(next_peer_str) = routing_path.first() {
        let next_peer = match PeerId::from_str(next_peer_str) {
            Ok(peer) => peer,
            Err(e) => {
                return (
                    false,
                    serde_json::json!({
                        "ok": false,
                        "chain_type": "CHAIN_ERROR",
                        "error": format!("bad_next_peer: {}", e),
                    })
                    .to_string()
                    .into_bytes(),
                );
            }
        };
        if let Some(obj) = body.as_object_mut() {
            obj.insert(
                "routing_path".to_string(),
                serde_json::json!(routing_path[1..].to_vec()),
            );
        }
        let payload = serde_json::to_vec(&body).unwrap_or_else(|_| frame.payload.clone());
        let next_frame = PipelineFrame {
            frame_type: PIPELINE_FRAME_REQUEST,
            request_id: frame.request_id,
            session_id: frame.session_id,
            step_id: frame.step_id,
            dtype: frame.dtype,
            payload,
        };
        return match pipeline_stream_roundtrip(
            stream_control,
            stream_cache,
            next_peer,
            next_frame,
            stream_ttl,
        )
        .await
        {
            Ok((response, trace)) => {
                let mut value = serde_json::from_slice::<serde_json::Value>(&response.payload)
                    .unwrap_or_else(|_| serde_json::json!({"ok": false, "chain_type": "CHAIN_ERROR", "error": "bad_downstream_json"}));
                if let Some(obj) = value.as_object_mut() {
                    obj.insert("chain_forwarded".to_string(), serde_json::json!(true));
                    obj.insert(
                        "chain_roundtrip_ms".to_string(),
                        serde_json::json!(trace.stream_roundtrip_ms),
                    );
                    obj.insert(
                        "chain_reused".to_string(),
                        serde_json::json!(trace.stream_reused),
                    );
                }
                (
                    value.get("ok").and_then(|v| v.as_bool()).unwrap_or(false),
                    value.to_string().into_bytes(),
                )
            }
            Err(e) => (
                false,
                serde_json::json!({
                    "ok": false,
                    "chain_type": "CHAIN_ERROR",
                    "error": e,
                    "latency_ms": started.elapsed().as_millis() as u64,
                })
                .to_string()
                .into_bytes(),
            ),
        };
    }

    let payload_bytes = body
        .get("payload_b64")
        .and_then(|v| v.as_str())
        .and_then(|s| general_purpose::STANDARD.decode(s).ok())
        .unwrap_or_else(|| frame.payload.clone());
    let chain_type = match frame.dtype.as_str() {
        "vryx.chain.hello" => "CHAIN_READY",
        "vryx.chain.ready" => "CHAIN_READY",
        "vryx.chain.ping" => "CHAIN_PONG",
        "vryx.chain.echo" => "CHAIN_ECHO",
        "vryx.chain.fake_tensor" => "CHAIN_READY",
        other => {
            return (
                false,
                serde_json::json!({
                    "ok": false,
                    "chain_type": "CHAIN_ERROR",
                    "error": format!("unexpected_dtype: {}", other),
                    "expected": [
                        "vryx.chain.hello",
                        "vryx.chain.ping",
                        "vryx.chain.echo",
                        "vryx.chain.fake_tensor",
                        "vryx.chain.forward",
                        "vryx.chain.forward.batch",
                        "vryx.chain.forward.batch.step",
                        "vryx.chain.result"
                    ],
                })
                .to_string()
                .into_bytes(),
            );
        }
    };
    (
        true,
        serde_json::json!({
            "ok": true,
            "chain_type": chain_type,
            "request_id": frame.request_id,
            "session_id": frame.session_id,
            "step_id": frame.step_id,
            "dtype": frame.dtype,
            "payload_bytes": payload_bytes.len(),
            "checksum": bytes_checksum(&payload_bytes),
            "tensor_dtype": body.get("tensor_dtype").and_then(|v| v.as_str()),
            "shape": body.get("shape").cloned().unwrap_or(serde_json::Value::Null),
            "latency_ms": started.elapsed().as_millis() as u64,
        })
        .to_string()
        .into_bytes(),
    )
}

#[allow(clippy::too_many_arguments)]
async fn handle_pipeline_stream(
    peer: PeerId,
    my_peer_id: PeerId,
    mut stream: libp2p::Stream,
    grpc_port: u16,
    trace_shard: Arc<Mutex<Option<serde_json::Value>>>,
    stream_control: Arc<tokio::sync::Mutex<libp2p_stream::Control>>,
    stream_cache: PipelineStreamCache,
    stream_ttl: Duration,
    chain_pending_results: ChainPendingResults,
) {
    loop {
        let frame =
            match tokio::time::timeout(pipeline_frame_deadline(), read_pipeline_frame(&mut stream))
                .await
            {
                Ok(Ok(frame)) => frame,
                Ok(Err(e)) => {
                    eprintln!("[PIPELINE_STREAM] fermeture stream {} : {}", peer, e);
                    break;
                }
                Err(_) => {
                    eprintln!("[PIPELINE_STREAM] timeout lecture frame {}", peer);
                    break;
                }
            };
        if frame.frame_type != PIPELINE_FRAME_REQUEST {
            eprintln!(
                "[PIPELINE_STREAM] frame ignorée de {} : type={}",
                peer, frame.frame_type
            );
            continue;
        }
        if frame.dtype == "vryx.chain.result" {
            let result_json = serde_json::from_slice::<serde_json::Value>(&frame.payload)
                .unwrap_or_else(|_| serde_json::json!({"ok": false, "chain_type": "CHAIN_ERROR", "error": "bad_chain_result_json"}));
            let session = result_json
                .get("session_id")
                .and_then(|v| v.as_str())
                .unwrap_or(&frame.session_id);
            let request = result_json
                .get("request_id")
                .and_then(|v| v.as_str())
                .unwrap_or(&frame.request_id);
            let step = result_json
                .get("step_id")
                .and_then(|v| v.as_u64())
                .unwrap_or(frame.step_id);
            let chain_type = result_json
                .get("chain_type")
                .and_then(|v| v.as_str())
                .unwrap_or("");
            let microbatch_id = result_json
                .get("microbatch_id")
                .and_then(|v| v.as_str())
                .unwrap_or("");
            let key = if (chain_type == "CHAIN_BATCH_RESULT" || chain_type == "CHAIN_BATCH_ERROR") && !microbatch_id.is_empty() {
                format!("{}:{}:batch:{}", session, request, microbatch_id)
            } else {
                chain_pending_key(session, request, step)
            };
            let pending = { chain_pending_results.lock().await.remove(&key) };
            let duplicate = pending.is_none();
            if let Some(tx) = pending {
                let _ = tx.send(result_json.clone());
            } else {
                eprintln!(
                    "[CHAIN_RESULT] duplicate_or_unknown_result key={} from={}",
                    key, peer
                );
            }
            let response_frame = PipelineFrame {
                frame_type: PIPELINE_FRAME_RESPONSE,
                request_id: frame.request_id,
                session_id: frame.session_id,
                step_id: frame.step_id,
                dtype: frame.dtype,
                payload: serde_json::json!({
                    "ok": true,
                    "chain_type": "CHAIN_RESULT_ACK",
                    "duplicate": duplicate,
                    "key": key,
                    "to_peer": my_peer_id.to_string(),
                })
                .to_string()
                .into_bytes(),
            };
            let write_result = tokio::time::timeout(
                pipeline_frame_deadline(),
                write_pipeline_frame(&mut stream, &response_frame),
            )
            .await;
            if !matches!(write_result, Ok(Ok(()))) {
                eprintln!(
                    "[PIPELINE_STREAM] ack chain_result impossible vers {}",
                    peer
                );
                break;
            }
            continue;
        }
        if frame.dtype.starts_with("vryx.chain.") {
            let response = handle_chain_control_frame(
                peer,
                my_peer_id,
                frame.clone(),
                grpc_port,
                Arc::clone(&stream_control),
                Arc::clone(&stream_cache),
                stream_ttl,
            )
            .await;
            let response_frame = PipelineFrame {
                frame_type: if response.0 {
                    PIPELINE_FRAME_RESPONSE
                } else {
                    PIPELINE_FRAME_ERROR
                },
                request_id: frame.request_id,
                session_id: frame.session_id,
                step_id: frame.step_id,
                dtype: frame.dtype,
                payload: response.1,
            };
            let write_result = tokio::time::timeout(
                pipeline_frame_deadline(),
                write_pipeline_frame(&mut stream, &response_frame),
            )
            .await;
            if !matches!(write_result, Ok(Ok(()))) {
                eprintln!("[PIPELINE_STREAM] réponse chain impossible vers {}", peer);
                break;
            }
            continue;
        }
        let dtype_in = frame.dtype.clone();
        let session_id = frame.session_id.clone();
        let routing_path: Vec<String> = serde_json::from_slice::<serde_json::Value>(&frame.payload)
            .ok()
            .and_then(|v| {
                v.get("routing_path").and_then(|r| r.as_array()).map(|arr| {
                    arr.iter()
                        .filter_map(|x| x.as_str().map(|s| s.to_string()))
                        .collect::<Vec<String>>()
                })
            })
            .unwrap_or_default();
        let compute_started = Instant::now();
        let response = match call_local_inference(
            grpc_port,
            frame.payload,
            dtype_in.clone(),
            Vec::new(),
            session_id.clone(),
        )
        .await
        {
            Ok((data, c, s, metrics, c_ms)) => {
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
                        "transport": "pipeline_stream",
                        "ts_ms": std::time::SystemTime::now()
                            .duration_since(std::time::UNIX_EPOCH)
                            .map(|d| d.as_millis())
                            .unwrap_or(0),
                    }));
                }
                let mut local_response = TensorResponse {
                    data,
                    compute_time_ns: c,
                    serialization_time_ns: s,
                    prompt_tokens_llm: metrics.prompt_tokens,
                    completion_tokens_llm: metrics.completion_tokens,
                    total_tokens_llm: metrics.total_tokens,
                    vps_delegate_ms: compute_started.elapsed().as_millis() as u64,
                    worker_compute_ms: c_ms,
                    p2p_messages_in: 0,
                    p2p_messages_out: 0,
                    shard_session_id: metrics.shard_session_id,
                    scheduler_workers_used: 0,
                    shard_warmup_sent: 0,
                    compute_time_ms: c_ms,
                    relay_trace_json: serde_json::json!({
                        "transport": "pipeline_stream",
                        "worker_seen_request": true,
                        "worker_compute_ms": c_ms,
                        "pipeline_stream_worker_ms": compute_started.elapsed().as_millis() as u64,
                    })
                    .to_string(),
                };
                if let Some(next_peer_str) = routing_path.first() {
                    match PeerId::from_str(next_peer_str) {
                        Ok(next_peer) => {
                            let next_payload = if routing_path.len() > 1 {
                                serde_json::from_slice::<serde_json::Value>(&local_response.data)
                                    .ok()
                                    .and_then(|mut v| {
                                        if let Some(obj) = v.as_object_mut() {
                                            obj.insert(
                                                "routing_path".to_string(),
                                                serde_json::json!(routing_path[1..].to_vec()),
                                            );
                                        }
                                        serde_json::to_vec(&v).ok()
                                    })
                                    .unwrap_or_else(|| local_response.data.clone())
                            } else {
                                local_response.data.clone()
                            };
                            let next_frame = PipelineFrame {
                                frame_type: PIPELINE_FRAME_REQUEST,
                                request_id: frame.request_id.clone(),
                                session_id: frame.session_id.clone(),
                                step_id: frame.step_id,
                                dtype: dtype_in.clone(),
                                payload: next_payload,
                            };
                            match pipeline_stream_roundtrip(
                                Arc::clone(&stream_control),
                                Arc::clone(&stream_cache),
                                next_peer,
                                next_frame,
                                stream_ttl,
                            )
                            .await
                            {
                                Ok((response_frame, trace)) => {
                                    match serde_json::from_slice::<TensorResponse>(
                                        &response_frame.payload,
                                    ) {
                                        Ok(mut downstream) => {
                                            downstream.compute_time_ns =
                                                downstream.compute_time_ns.saturating_add(c);
                                            downstream.compute_time_ms =
                                                downstream.compute_time_ms.saturating_add(c_ms);
                                            downstream.worker_compute_ms =
                                                downstream.worker_compute_ms.saturating_add(c_ms);
                                            downstream.relay_trace_json = serde_json::json!({
                                                "transport": "pipeline_stream_chain",
                                                "worker_seen_request": true,
                                                "worker_compute_ms": c_ms,
                                                "chain_stream_used": true,
                                                "chain_downstream_peer": next_peer.to_string(),
                                                "chain_roundtrip_ms": trace.stream_roundtrip_ms,
                                                "chain_reused": trace.stream_reused,
                                                "chain_payload_bytes": downstream.data.len(),
                                            })
                                            .to_string();
                                            local_response = downstream;
                                        }
                                        Err(e) => {
                                            local_response.data = serde_json::json!({
                                                "ok": false,
                                                "error": format!("pipeline_stream_chain_decode_failed: {}", e),
                                                "chain_stream_used": true,
                                            })
                                            .to_string()
                                            .into_bytes();
                                        }
                                    }
                                }
                                Err(e) => {
                                    local_response.data = serde_json::json!({
                                        "ok": false,
                                        "error": format!("pipeline_stream_chain_forward_failed: {}", e),
                                        "chain_stream_used": true,
                                    })
                                    .to_string()
                                    .into_bytes();
                                }
                            }
                        }
                        Err(e) => {
                            local_response.data = serde_json::json!({
                                "ok": false,
                                "error": format!("pipeline_stream_bad_next_peer: {}", e),
                                "chain_stream_used": true,
                            })
                            .to_string()
                            .into_bytes();
                        }
                    }
                }
                local_response
            }
            Err(e) => TensorResponse {
                data: serde_json::json!({
                    "ok": false,
                    "error": format!("pipeline_stream_worker_error: {}", e),
                })
                .to_string()
                .into_bytes(),
                relay_trace_json: serde_json::json!({
                    "transport": "pipeline_stream",
                    "worker_seen_request": true,
                    "error": e.to_string(),
                })
                .to_string(),
                ..Default::default()
            },
        };
        let payload = match serde_json::to_vec(&response) {
            Ok(payload) => payload,
            Err(e) => {
                eprintln!(
                    "[PIPELINE_STREAM] sérialisation réponse impossible {} : {}",
                    peer, e
                );
                break;
            }
        };
        let response_frame = PipelineFrame {
            frame_type: PIPELINE_FRAME_RESPONSE,
            request_id: frame.request_id,
            session_id: frame.session_id,
            step_id: frame.step_id,
            dtype: frame.dtype,
            payload,
        };
        let write_result = tokio::time::timeout(
            pipeline_frame_deadline(),
            write_pipeline_frame(&mut stream, &response_frame),
        )
        .await;
        if !matches!(write_result, Ok(Ok(()))) {
            eprintln!("[PIPELINE_STREAM] réponse impossible vers {}", peer);
            break;
        }
    }
}

async fn pipeline_stream_roundtrip(
    control: Arc<tokio::sync::Mutex<libp2p_stream::Control>>,
    cache: PipelineStreamCache,
    peer: PeerId,
    frame: PipelineFrame,
    ttl: Duration,
) -> std::result::Result<(PipelineFrame, PipelineStreamTrace), String> {
    let key = pipeline_stream_cache_key(&frame.session_id, &peer);
    let roundtrip_started = Instant::now();
    let mut last_error = String::new();
    for attempt in 0..2 {
        let now = Instant::now();
        let mut stream_open_ms = 0u64;
        let mut stream_reused = false;
        let handle = {
            let cached = {
                let mut guard = cache.lock().unwrap();
                guard.retain(|_, entry| now.duration_since(entry.opened_at) <= ttl);
                guard.get(&key).cloned()
            };
            if let Some(handle) = cached {
                stream_reused = true;
                handle
            } else {
                let open_started = Instant::now();
                let mut control_guard = control.lock().await;
                let stream = control_guard
                    .open_stream(peer, StreamProtocol::new(PIPELINE_STREAM_PROTOCOL))
                    .await
                    .map_err(|e| format!("pipeline_stream_open_failed: {}", e))?;
                stream_open_ms = open_started.elapsed().as_millis() as u64;
                let handle = PipelineStreamHandle {
                    stream: Arc::new(tokio::sync::Mutex::new(stream)),
                    opened_at: Instant::now(),
                };
                cache.lock().unwrap().insert(key.clone(), handle.clone());
                handle
            }
        };
        let mut stream_guard = handle.stream.lock().await;
        let send_started = Instant::now();
        match tokio::time::timeout(
            pipeline_frame_deadline(),
            write_pipeline_frame(&mut stream_guard, &frame),
        )
        .await
        {
            Ok(Ok(())) => {}
            Ok(Err(e)) => {
                last_error = format!("pipeline_stream_send_failed: {}", e);
                cache.lock().unwrap().remove(&key);
                if attempt == 0 {
                    continue;
                }
                break;
            }
            Err(_) => {
                last_error = "pipeline_stream_send_timeout".to_string();
                cache.lock().unwrap().remove(&key);
                if attempt == 0 {
                    continue;
                }
                break;
            }
        }
        let stream_send_ms = send_started.elapsed().as_millis() as u64;
        let wait_started = Instant::now();
        match tokio::time::timeout(
            pipeline_frame_deadline(),
            read_pipeline_frame(&mut stream_guard),
        )
        .await
        {
            Ok(Ok(response)) => {
                let trace = PipelineStreamTrace {
                    stream_open_ms,
                    stream_reused,
                    stream_send_ms,
                    stream_wait_response_ms: wait_started.elapsed().as_millis() as u64,
                    stream_roundtrip_ms: roundtrip_started.elapsed().as_millis() as u64,
                    request_response_fallback: false,
                    frames_sent: 1,
                    frames_received: 1,
                };
                return Ok((response, trace));
            }
            Ok(Err(e)) => {
                last_error = format!("pipeline_stream_read_failed: {}", e);
                cache.lock().unwrap().remove(&key);
                if attempt == 0 {
                    continue;
                }
            }
            Err(_) => {
                last_error = "pipeline_stream_read_timeout".to_string();
                cache.lock().unwrap().remove(&key);
                if attempt == 0 {
                    continue;
                }
            }
        }
    }
    Err(last_error)
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

fn env_bool_flag(name: &str) -> Option<bool> {
    std::env::var(name)
        .ok()
        .and_then(|v| match v.trim().to_ascii_lowercase().as_str() {
            "1" | "true" | "yes" | "on" => Some(true),
            "0" | "false" | "no" | "off" => Some(false),
            _ => None,
        })
}

fn is_private_or_local_ipv4(ip: &Ipv4Addr) -> bool {
    ip.is_private() || ip.is_loopback() || ip.is_link_local() || ip.is_unspecified()
}

fn is_private_or_local_ipv6(ip: &Ipv6Addr) -> bool {
    ip.is_loopback() || ip.is_unspecified() || ip.is_unique_local() || ip.is_unicast_link_local()
}

fn should_keep_identify_addr(addr: &Multiaddr, filter_private: bool) -> bool {
    if !filter_private {
        return true;
    }
    let mut saw_ip = false;
    for proto in addr.iter() {
        match proto {
            libp2p::multiaddr::Protocol::P2pCircuit => return true,
            libp2p::multiaddr::Protocol::Ip4(ip) => {
                saw_ip = true;
                if is_private_or_local_ipv4(&ip) {
                    return false;
                }
            }
            libp2p::multiaddr::Protocol::Ip6(ip) => {
                saw_ip = true;
                if is_private_or_local_ipv6(&ip) {
                    return false;
                }
            }
            _ => {}
        }
    }
    saw_ip
}

fn heartbeat_machine_info_with_network(
    machine_info: Option<serde_json::Value>,
    p2p_port: u16,
) -> Option<serde_json::Value> {
    let direct_ready = env_bool_flag("VRYX_DIRECT_READY");
    let route_mode = std::env::var("VRYX_ROUTE_MODE")
        .ok()
        .map(|v| v.trim().to_ascii_lowercase())
        .filter(|v| !v.is_empty());
    let public_ip = std::env::var("VRYX_PUBLIC_IP")
        .or_else(|_| std::env::var("VRYX_DIRECT_PUBLIC_IP"))
        .ok()
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty());
    let public_port = std::env::var("VRYX_DIRECT_PUBLIC_PORT")
        .ok()
        .and_then(|v| v.trim().parse::<u16>().ok())
        .filter(|port| *port > 0);
    let proof_at = std::env::var("VRYX_DIRECT_PROOF_AT")
        .ok()
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty());

    if direct_ready.is_none()
        && route_mode.is_none()
        && public_ip.is_none()
        && public_port.is_none()
        && proof_at.is_none()
    {
        return machine_info;
    }

    let mut root = machine_info
        .filter(|value| value.is_object())
        .unwrap_or_else(|| serde_json::json!({}));
    let Some(root_obj) = root.as_object_mut() else {
        return Some(root);
    };
    let network_entry = root_obj
        .entry("network".to_string())
        .or_insert_with(|| serde_json::json!({}));
    if !network_entry.is_object() {
        *network_entry = serde_json::json!({});
    }
    if let Some(network) = network_entry.as_object_mut() {
        if let Some(value) = direct_ready {
            network.insert("directReady".to_string(), serde_json::json!(value));
        }
        if let Some(value) = route_mode {
            network.insert("routeMode".to_string(), serde_json::json!(value));
        }
        if let Some(value) = public_ip {
            network.insert("publicIp".to_string(), serde_json::json!(value));
        }
        if let Some(value) = public_port {
            network.insert("publicP2pPort".to_string(), serde_json::json!(value));
        }
        if let Some(value) = proof_at {
            network.insert("directProofAt".to_string(), serde_json::json!(value));
        }
        if p2p_port > 0 {
            network.insert("p2pPort".to_string(), serde_json::json!(p2p_port));
        }
    }
    Some(root)
}

fn tensor_yamux_config() -> yamux::Config {
    let mut config = yamux::Config::default();
    #[allow(deprecated)]
    config.set_receive_window_size(10 * 1024 * 1024);
    config
}

fn heartbeat_allocated_vram_mb(gpu_vram_mb: Option<u64>) -> (Option<u64>, Option<u8>) {
    let limit_from_gb = env_f64_positive("VRYX_WORKER_MEMORY_LIMIT_GB")
        .map(|gb| (gb * 1024.0).round() as u64)
        .filter(|mb| *mb > 0);
    let percent = env_f64_positive("VRYX_WORKER_MEMORY_LIMIT_PERCENT")
        .map(|p| p.round().clamp(1.0, 100.0) as u8);
    let limit_from_percent = match (gpu_vram_mb, percent) {
        (Some(vram), Some(pct)) if vram > 0 => {
            Some(((vram as f64) * (pct as f64 / 100.0)).round() as u64)
        }
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
    use base64::{engine::general_purpose, Engine as _};
    use serde::{Deserialize, Deserializer, Serialize, Serializer};

    pub fn serialize<S>(bytes: &[u8], serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        general_purpose::STANDARD
            .encode(bytes)
            .serialize(serializer)
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
    request_response: request_response::Behaviour<vryx_codec::Codec<TensorRequest, TensorResponse>>,
    stream: libp2p_stream::Behaviour,
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

use tonic::transport::Channel;
use vryx::inference_service_client::InferenceServiceClient;

static LOCAL_INFERENCE_CHANNELS: OnceLock<Mutex<HashMap<u16, Channel>>> = OnceLock::new();

async fn connect_local_inference_channel(
    port: u16,
) -> Result<Channel, Box<dyn Error + Send + Sync>> {
    // Le serveur Python peut redémarrer pendant le chargement du modèle. Un canal tonic réutilisé
    // garde parfois une socket morte et se traduit par un "transport error" côté P2P.
    let endpoint = Channel::from_shared(format!("http://127.0.0.1:{}", port))?
        .connect_timeout(Duration::from_secs(8))
        .timeout(Duration::from_secs(900))
        .tcp_nodelay(true);
    Ok(endpoint.connect().await?)
}

async fn local_inference_channel(
    port: u16,
) -> Result<Channel, Box<dyn Error + Send + Sync>> {
    let cache_enabled = env_bool_flag("VRYX_GRPC_CHANNEL_CACHE").unwrap_or(true);
    if !cache_enabled {
        return connect_local_inference_channel(port).await;
    }
    let cache = LOCAL_INFERENCE_CHANNELS.get_or_init(|| Mutex::new(HashMap::new()));
    if let Some(channel) = cache.lock().unwrap().get(&port).cloned() {
        return Ok(channel);
    }
    let channel = connect_local_inference_channel(port).await?;
    cache.lock().unwrap().insert(port, channel.clone());
    Ok(channel)
}

fn invalidate_local_inference_channel(port: u16) {
    if let Some(cache) = LOCAL_INFERENCE_CHANNELS.get() {
        cache.lock().unwrap().remove(&port);
    }
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
        println!(
            "[*] Nouveau keypair généré et sauvegardé dans {}",
            path.display()
        );
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
        return (
            0,
            find_number("max_new_tokens").max(find_number("maxNewTokens")),
        );
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

fn extract_transport_trace_from_response_data(data: &[u8]) -> serde_json::Value {
    let Ok(v) = serde_json::from_slice::<serde_json::Value>(data) else {
        return serde_json::Value::Null;
    };
    v.get("transport_trace")
        .cloned()
        .unwrap_or(serde_json::Value::Null)
}

async fn call_local_inference_once(
    port: u16,
    data: Vec<u8>,
    dtype: String,
    routing_path: Vec<String>,
    session_id: String,
) -> Result<(Vec<u8>, u64, u64, LlmMetrics, u64), Box<dyn Error + Send + Sync>> {
    let channel = local_inference_channel(port).await?;
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
                m.prompt_tokens = metrics
                    .get("prompt_tokens")
                    .and_then(|x| x.as_u64())
                    .unwrap_or(0);
            }
            if m.completion_tokens == 0 {
                m.completion_tokens = metrics
                    .get("completion_tokens")
                    .or_else(|| metrics.get("tokens_generated"))
                    .and_then(|x| x.as_u64())
                    .unwrap_or(0);
            }
            if m.total_tokens == 0 {
                m.total_tokens = metrics
                    .get("total_tokens")
                    .and_then(|x| x.as_u64())
                    .unwrap_or(0);
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
            tokio::time::sleep(std::time::Duration::from_millis(
                200 + u64::from(attempt) * 400,
            ))
            .await;
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
                    invalidate_local_inference_channel(port);
                    eprintln!(
                        "[!] gRPC local port {} : tentative {} — {}",
                        port,
                        attempt + 1,
                        msg
                    );
                    continue;
                }
                return Err(Box::new(std::io::Error::other(msg)));
            }
        }
    }
    Err(Box::new(std::io::Error::other(if last_msg.is_empty() {
        "gRPC local : échec inattendu.".to_string()
    } else {
        last_msg
    })))
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
#[cfg(target_os = "macos")]
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
#[cfg(target_os = "macos")]
fn sysctl_hw_memsize_mib() -> Option<u64> {
    sysctl_n_trimmed("hw.memsize")
        .and_then(|s| s.parse::<u64>().ok())
        .map(|b| b / (1024 * 1024))
}

/// Interprète `spdisplays_vram` ou équivalent (« 16 Go », « 16384 Mo », « 8192 », …) → MiB.
#[cfg(target_os = "macos")]
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
    if (4.0..=256.0).contains(&n) {
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
    let Some(mib) = parts
        .next()
        .and_then(|s| s.parse::<u64>().ok())
        .filter(|&n| n > 0)
    else {
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
    HEARTBEAT_GPU_HW
        .get_or_init(detect_heartbeat_gpu_hardware)
        .clone()
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

fn resolve_worker_secret() -> String {
    std::env::var("VRYX_WORKER_SECRET")
        .or_else(|_| std::env::var("WORKER_SECRET"))
        .unwrap_or_default()
        .trim()
        .to_string()
}

fn apply_worker_secret_headers(
    req: reqwest::RequestBuilder,
    token: &str,
) -> reqwest::RequestBuilder {
    if token.is_empty() {
        req
    } else {
        req.header("Authorization", format!("Bearer {}", token))
            .header("x-worker-secret", token.to_string())
    }
}

async fn send_heartbeat(client: &reqwest::Client, api_url: &str, payload: &HeartbeatPayload) {
    let url = format!("{}/api/workers/heartbeat", api_url.trim_end_matches('/'));
    let token = resolve_worker_secret();

    let req = apply_worker_secret_headers(client.post(&url).json(payload), &token);

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
                                let ack_url = format!(
                                    "{}/api/workers/heartbeat",
                                    api_url.trim_end_matches('/')
                                );
                                let ack_payload = serde_json::json!({
                                    "peer_id": payload.peer_id,
                                    "mode": payload.mode,
                                    "command_ack": { "id": cmd_id, "status": "acknowledged" }
                                });
                                let ack_req = apply_worker_secret_headers(
                                    client.post(&ack_url).json(&ack_payload),
                                    &token,
                                );
                                let _ = ack_req.send().await;
                                std::process::exit(0);
                            }
                            "set_memory" => {
                                println!(
                                    "[VRYX_REMOTE_COMMAND] Action=set_memory (cmd={}) → acknowledged.",
                                    cmd_id
                                );
                                let ack_url = format!(
                                    "{}/api/workers/heartbeat",
                                    api_url.trim_end_matches('/')
                                );
                                let ack_payload = serde_json::json!({
                                    "peer_id": payload.peer_id,
                                    "mode": payload.mode,
                                    "command_ack": { "id": cmd_id, "status": "acknowledged" }
                                });
                                let ack_req = apply_worker_secret_headers(
                                    client.post(&ack_url).json(&ack_payload),
                                    &token,
                                );
                                let _ = ack_req.send().await;
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
                                let reload_url = format!(
                                    "http://127.0.0.1:{}/internal/hot-reload-python",
                                    admin_port
                                );
                                let reload_body = serde_json::json!({
                                    "files": files,
                                    "command_id": cmd_id,
                                });
                                println!(
                                    "[VRYX_REMOTE_COMMAND] Action=hot_reload_python (cmd={}) → POST {}",
                                    cmd_id, reload_url
                                );
                                let mut ack_status = "failed";
                                let mut ack_error: Option<String> = None;
                                match client
                                    .post(&reload_url)
                                    .json(&reload_body)
                                    .timeout(std::time::Duration::from_secs(15))
                                    .send()
                                    .await
                                {
                                    Ok(resp) => {
                                        let status = resp.status();
                                        let body_text = resp.text().await.unwrap_or_default();
                                        println!("[VRYX_REMOTE_COMMAND] hot_reload_python → HTTP {} : {}", status, body_text);
                                        if status.is_success() {
                                            ack_status = "acknowledged";
                                        } else {
                                            ack_error = Some(format!(
                                                "hot_reload_python HTTP {}: {}",
                                                status, body_text
                                            ));
                                        }
                                    }
                                    Err(e) => {
                                        eprintln!("[VRYX_REMOTE_COMMAND] hot_reload_python POST échec : {}", e);
                                        ack_error =
                                            Some(format!("hot_reload_python POST échec : {}", e));
                                    }
                                }
                                let ack_url = format!(
                                    "{}/api/workers/heartbeat",
                                    api_url.trim_end_matches('/')
                                );
                                let ack_payload = serde_json::json!({
                                    "peer_id": payload.peer_id,
                                    "mode": payload.mode,
                                    "command_ack": {
                                        "id": cmd_id,
                                        "status": ack_status,
                                        "error": ack_error,
                                    }
                                });
                                let ack_req = apply_worker_secret_headers(
                                    client.post(&ack_url).json(&ack_payload),
                                    &token,
                                );
                                let _ = ack_req.send().await;
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
            let status = r.status();
            let body = r.text().await.unwrap_or_default();
            let detail = body.chars().take(240).collect::<String>();
            eprintln!("[!] Heartbeat HTTP {} → {} {}", status, url, detail);
        }
        Err(e) => {
            eprintln!("[!] Heartbeat erreur : {}", e);
        }
    }
}

/// Initiateur : lit `/api/workers/status`, enregistre les workers et relance un dial relay.
/// Évite la course avec le ticker heartbeat (~30 s) quand `/api/chat` arrive juste après le démarrage.
#[allow(clippy::too_many_arguments)]
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
    let url = format!(
        "{}/api/workers/status?peer_id={}",
        api_url.trim_end_matches('/'),
        my_peer_id
    );
    let token = resolve_worker_secret();
    let fetch = async {
        let req = apply_worker_secret_headers(http_client.get(&url), &token);
        let resp = req.send().await.ok()?;
        if !resp.status().is_success() {
            return None;
        }
        resp.json::<serde_json::Value>().await.ok()
    };
    let body = match tokio::time::timeout(Duration::from_secs(4), fetch).await {
        Ok(Some(json)) => json,
        Ok(None) => {
            if log_origin == "chat" {
                eprintln!("[P2P] Pré-chat : HTTP invalide ou JSON pour {}", url);
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
        swarm
            .behaviour_mut()
            .kad
            .add_address(&peer_id, relay_addr.clone());
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
                eprintln!("[!] Dial worker {} échoué ({:?})", peer_id, e);
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
    let filter_private_identify_addrs =
        env_bool_flag("VRYX_P2P_FILTER_PRIVATE_IDENTIFY_ADDRS").unwrap_or(false);
    let enable_swarm_quic = env_bool_flag("VRYX_P2P_LISTEN_QUIC").unwrap_or(true);

    // Filtre de log : on coupe le spam yamux/noise/autonat sauf si RUST_LOG est positionné.
    if std::env::var("RUST_LOG").is_err() {
        std::env::set_var(
            "RUST_LOG",
            "info,yamux=error,libp2p_yamux=error,\
             libp2p_noise=error,libp2p_autonat=error,\
             libp2p_relay=error,libp2p_dcutr=error,\
             libp2p_kad=error,libp2p_identify=error",
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
            tensor_yamux_config,
        )?
        .with_quic()
        .with_relay_client(noise::Config::new, tensor_yamux_config)?
        .with_behaviour(|key, relay_behaviour| {
            let peer_id = key.public().to_peer_id();
            let p2p_request_timeout_s =
                env_u64_clamped("VRYX_P2P_REQUEST_TIMEOUT_S", 3600, 30, 7200);
            let rr_config = request_response::Config::default()
                .with_request_timeout(Duration::from_secs(p2p_request_timeout_s));
            // Codec personnalisé 512 MB pour le transfert de tranches de poids LLM.
            let request_response = request_response::Behaviour::with_codec(
                vryx_codec::Codec::<TensorRequest, TensorResponse>::default(),
                [(
                    StreamProtocol::new("/vryx/tensor/1.0.0"),
                    ProtocolSupport::Full,
                )],
                rr_config,
            );
            let stream = libp2p_stream::Behaviour::new();
            let store = kad::store::MemoryStore::new(peer_id);
            let mut kad = kad::Behaviour::new(peer_id, store);
            if args.mode == "bootstrap" {
                kad.set_mode(Some(kad::Mode::Server));
            }
            let identify =
                identify::Behaviour::new(identify::Config::new("/vryx/1.0.0".into(), key.public()));
            let autonat = autonat::Behaviour::new(peer_id, autonat::Config::default());
            let dcutr = dcutr::Behaviour::new(peer_id);
            let relay_server = if args.mode == "bootstrap" {
                let config = libp2p::relay::Config {
                    reservation_duration: Duration::from_secs(3600),
                    max_reservations: 1000,
                    max_circuits: 1000,
                    max_circuit_duration: Duration::from_secs(3600),
                    max_circuit_bytes: 1024 * 1024 * 1024, // 1 GB
                    reservation_rate_limiters: vec![],
                    circuit_src_rate_limiters: vec![],
                    ..Default::default()
                };
                Some(libp2p::relay::Behaviour::new(peer_id, config))
            } else {
                None
            }
            .into();

            Ok(VryxBehaviour {
                request_response,
                stream,
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
    if enable_swarm_quic {
        swarm.listen_on(format!("/ip4/0.0.0.0/udp/{}/quic-v1", args.p2p_port).parse()?)?;
    } else {
        println!(
            "[P2P] QUIC swarm désactivé par VRYX_P2P_LISTEN_QUIC=0 ; écoute TCP + relay uniquement."
        );
    }
    if args.mode == "bootstrap" {
        swarm.add_external_address(format!("/ip4/51.222.26.225/tcp/{}", args.p2p_port).parse()?);
        if enable_swarm_quic {
            swarm.add_external_address(
                format!("/ip4/51.222.26.225/udp/{}/quic-v1", args.p2p_port).parse()?,
            );
        }
    }

    let my_peer_id = *swarm.local_peer_id();
    let pipeline_stream_ttl = Duration::from_secs(env_u64_clamped(
        "VRYX_PIPELINE_STREAM_TTL_SEC",
        3600,
        30,
        86400,
    ));
    let pipeline_stream_cache: PipelineStreamCache = Arc::new(Mutex::new(HashMap::new()));
    let chain_pending_results: ChainPendingResults =
        Arc::new(tokio::sync::Mutex::new(HashMap::new()));
    let pipeline_stream_control = Arc::new(tokio::sync::Mutex::new(
        swarm.behaviour().stream.new_control(),
    ));
    let mut pipeline_stream_incoming = swarm
        .behaviour()
        .stream
        .new_control()
        .accept(StreamProtocol::new(PIPELINE_STREAM_PROTOCOL))
        .map_err(|e| format!("pipeline stream protocol déjà enregistré: {:?}", e))?;
    println!("\n╔══════════════════════════════════════════════╗");
    println!("║  Vryx Node  │  mode = {}  ", args.mode);
    println!("║  vryx-daemon commit: {}", daemon_commit());
    println!("║  PeerId : {}", my_peer_id);
    println!("╚══════════════════════════════════════════════╝\n");

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
            axum_base64_decode_ms: u64,
            axum_request_payload_bytes: u64,
            libp2p_send_request_ms: u64,
        },
        Forwarded {
            original_channel: request_response::ResponseChannel<TensorResponse>,
        },
    }

    let mut pending_requests: HashMap<
        request_response::OutboundRequestId,
        (TensorRequest, PendingMeta),
    > = HashMap::new();
    // Requêtes POST /api/p2p/relay avant qu'une première connexion libp2p existe : send_request trop tôt → DialFailure libp2p.
    type RelayPendingTx = tokio::sync::oneshot::Sender<std::result::Result<TensorResponse, String>>;
    type RelayPendingQueue = HashMap<PeerId, VecDeque<(TensorRequest, RelayPendingTx, Instant)>>;
    let mut pending_relay_until_connected: RelayPendingQueue = HashMap::new();

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
    {
        let trace_shard_stream = Arc::clone(&last_shard_trace);
        let grpc_pipeline_stream = args.grpc_port;
        let control_pipeline_stream = Arc::clone(&pipeline_stream_control);
        let cache_pipeline_stream = Arc::clone(&pipeline_stream_cache);
        let chain_pending_results_stream = Arc::clone(&chain_pending_results);
        let ttl_pipeline_stream = pipeline_stream_ttl;
        tokio::spawn(async move {
            while let Some((peer, stream)) = pipeline_stream_incoming.next().await {
                let trace = Arc::clone(&trace_shard_stream);
                let control = Arc::clone(&control_pipeline_stream);
                let cache = Arc::clone(&cache_pipeline_stream);
                let pending = Arc::clone(&chain_pending_results_stream);
                tokio::spawn(handle_pipeline_stream(
                    peer,
                    my_peer_id,
                    stream,
                    grpc_pipeline_stream,
                    trace,
                    control,
                    cache,
                    ttl_pipeline_stream,
                    pending,
                ));
            }
        });
    }

    // Channel pour envoyer des commandes chat via l'API (initiator seulement)
    // (Prompt, Response Sender)
    let (cmd_tx, mut cmd_rx) =
        tokio::sync::mpsc::unbounded_channel::<(String, Option<ChatApiTx>)>();
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
        let pipeline_stream_control_axum = Arc::clone(&pipeline_stream_control);
        let pipeline_stream_cache_axum = Arc::clone(&pipeline_stream_cache);
        let pipeline_stream_ttl_axum = pipeline_stream_ttl;
        let pipeline_stream_control_chain_axum = Arc::clone(&pipeline_stream_control);
        let pipeline_stream_cache_chain_axum = Arc::clone(&pipeline_stream_cache);
        let pipeline_stream_ttl_chain_axum = pipeline_stream_ttl;
        let pipeline_stream_control_direct_axum = Arc::clone(&pipeline_stream_control);
        let pipeline_stream_cache_direct_axum = Arc::clone(&pipeline_stream_cache);
        let pipeline_stream_ttl_direct_axum = pipeline_stream_ttl;
        let chain_pending_results_axum = Arc::clone(&chain_pending_results);
        let my_peer_id_chain_axum = my_peer_id;
        let mode_chat = args.mode.clone();
        let mode_chat_stream = args.mode.clone();
        let mode_relay = args.mode.clone();
        let mode_pipeline_stream = args.mode.clone();
        let mode_chain_stream = args.mode.clone();
        let mode_chain_forward = args.mode.clone();
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
        let my_peer_id_health = my_peer_id.to_string();
        let mode_health = args.mode.clone();

        let app = Router::new()
            .route("/api/health", get(move || {
                let peer_id = my_peer_id_health.clone();
                let mode = mode_health.clone();
                async move {
                    Json(serde_json::json!({
                        "ok": true,
                        "peer_id": peer_id,
                        "daemon_mode": mode,
                        "daemon_version": daemon_version_json(),
                    }))
                }
            }))
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
                        "daemon_version": daemon_version_json(),
                        "version": env!("CARGO_PKG_VERSION"),
                        "commit": daemon_commit(),
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
                            .filter(|&mt| (1..=32768).contains(&mt))
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
                    if let Some(load_mode) = payload
                        .get("load_mode")
                        .or_else(|| payload.get("loadMode"))
                        .and_then(|v| v.as_str())
                        .map(|s| s.trim())
                        .filter(|s| matches!(*s, "auto" | "full" | "shard"))
                    {
                        request_obj["load_mode"] = serde_json::json!(load_mode);
                    }
                    if payload
                        .get("force_distributed")
                        .or_else(|| payload.get("forceDistributed"))
                        .and_then(|v| v.as_bool())
                        == Some(true)
                    {
                        request_obj["force_distributed"] = serde_json::json!(true);
                    }
                    if let Some(value) = payload
                        .get("warmup_only")
                        .or_else(|| payload.get("warmupOnly"))
                        .and_then(|v| v.as_bool())
                    {
                        request_obj["warmup_only"] = serde_json::json!(value);
                    }
                    for (snake, camel) in [
                        ("chain_stream", "chainStream"),
                        ("chain_result_direct", "chainResultDirect"),
                        ("chain_coalesced_decode", "chainCoalescedDecode"),
                        ("bench_ignore_eos", "benchIgnoreEos"),
                        ("bench_force_tokens", "benchForceTokens"),
                    ] {
                        if let Some(value) = payload
                            .get(snake)
                            .or_else(|| payload.get(camel))
                            .and_then(|v| v.as_bool())
                        {
                            request_obj[snake] = serde_json::json!(value);
                        }
                    }
                    if let Some(value) = payload
                        .get("decode_microbatch_cap")
                        .or_else(|| payload.get("decodeMicrobatchCap"))
                        .and_then(|v| {
                            v.as_u64().or_else(|| {
                                v.as_i64().and_then(|i| {
                                    if i >= 1 {
                                        Some(i as u64)
                                    } else {
                                        None
                                    }
                                })
                            })
                        })
                        .filter(|&v| (1..=64).contains(&v))
                    {
                        request_obj["decode_microbatch_cap"] = serde_json::json!(value);
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
                    .filter(|&mt| (1..=32768).contains(&mt))
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
                if let Some(load_mode) = payload
                    .get("load_mode")
                    .or_else(|| payload.get("loadMode"))
                    .and_then(|v| v.as_str())
                    .map(|s| s.trim())
                    .filter(|s| matches!(*s, "auto" | "full" | "shard"))
                {
                    request_obj["load_mode"] = serde_json::json!(load_mode);
                }
                if payload
                    .get("force_distributed")
                    .or_else(|| payload.get("forceDistributed"))
                    .and_then(|v| v.as_bool())
                    == Some(true)
                {
                    request_obj["force_distributed"] = serde_json::json!(true);
                }
                if let Some(value) = payload
                    .get("warmup_only")
                    .or_else(|| payload.get("warmupOnly"))
                    .and_then(|v| v.as_bool())
                {
                    request_obj["warmup_only"] = serde_json::json!(value);
                }
                for (snake, camel) in [
                    ("chain_stream", "chainStream"),
                    ("chain_result_direct", "chainResultDirect"),
                    ("chain_coalesced_decode", "chainCoalescedDecode"),
                    ("bench_ignore_eos", "benchIgnoreEos"),
                    ("bench_force_tokens", "benchForceTokens"),
                ] {
                    if let Some(value) = payload
                        .get(snake)
                        .or_else(|| payload.get(camel))
                        .and_then(|v| v.as_bool())
                    {
                        request_obj[snake] = serde_json::json!(value);
                    }
                }
                if let Some(value) = payload
                    .get("decode_microbatch_cap")
                    .or_else(|| payload.get("decodeMicrobatchCap"))
                    .and_then(|v| {
                        v.as_u64().or_else(|| {
                            v.as_i64().and_then(|i| {
                                if i >= 1 {
                                    Some(i as u64)
                                } else {
                                    None
                                }
                            })
                        })
                    })
                    .filter(|&v| (1..=64).contains(&v))
                {
                    request_obj["decode_microbatch_cap"] = serde_json::json!(value);
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
            .route("/api/p2p/chain-forward", post(move |Json(payload): Json<serde_json::Value>| {
                let control = Arc::clone(&pipeline_stream_control_direct_axum);
                let cache = Arc::clone(&pipeline_stream_cache_direct_axum);
                let pending_results = Arc::clone(&chain_pending_results_axum);
                let mode_chain_stream_call = mode_chain_forward.clone();
                async move {
                    use base64::{engine::general_purpose, Engine as _};
                    let started = Instant::now();
                    if mode_chain_stream_call != "initiator" {
                        return (
                            axum::http::StatusCode::FORBIDDEN,
                            Json(serde_json::json!({"ok": false, "error": "Chain forward : mode initiateur requis."})),
                        );
                    }
                    let target_str = payload.get("target_peer").and_then(|v| v.as_str()).unwrap_or("");
                    let final_str = payload.get("final_peer").and_then(|v| v.as_str()).unwrap_or("");
                    let target_peer: PeerId = match PeerId::from_str(target_str) {
                        Ok(p) => p,
                        Err(_) => {
                            return (
                                axum::http::StatusCode::BAD_REQUEST,
                                Json(serde_json::json!({"ok": false, "error": "target_peer libp2p invalide."})),
                            );
                        }
                    };
                    if PeerId::from_str(final_str).is_err() {
                        return (
                            axum::http::StatusCode::BAD_REQUEST,
                            Json(serde_json::json!({"ok": false, "error": "final_peer libp2p invalide."})),
                        );
                    }
                    let forward_dtype = payload
                        .get("forward_dtype")
                        .or_else(|| payload.get("dtype"))
                        .and_then(|v| v.as_str())
                        .unwrap_or("vryx.shard.pipeline")
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
                    let request_id = payload.get("request_id").and_then(|v| v.as_str()).unwrap_or("").to_string();
                    let step_id = payload
                        .get("step_id")
                        .and_then(|v| v.as_u64().or_else(|| v.as_i64().and_then(|i| if i >= 0 { Some(i as u64) } else { None })))
                        .unwrap_or(0);
                    let chain_frame_dtype = payload
                        .get("chain_frame_dtype")
                        .and_then(|v| v.as_str())
                        .unwrap_or("vryx.chain.forward")
                        .to_string();
                    let microbatch_id = payload
                        .get("microbatch_id")
                        .and_then(|v| v.as_str())
                        .unwrap_or("")
                        .to_string();
                    let token_start = payload.get("token_start").and_then(|v| v.as_u64()).unwrap_or(0);
                    let token_count = payload.get("token_count").and_then(|v| v.as_u64()).unwrap_or(1);
                    let key = if chain_frame_dtype == "vryx.chain.forward.batch" && !microbatch_id.is_empty() {
                        format!("{}:{}:batch:{}", session_id, request_id, microbatch_id)
                    } else {
                        chain_pending_key(&session_id, &request_id, step_id)
                    };
                    let (tx, rx) = tokio::sync::oneshot::channel::<serde_json::Value>();
                    let (pending_count_before, pending_count_after_insert) = {
                        let mut guard = pending_results.lock().await;
                        let before = guard.len();
                        if guard.insert(key.clone(), tx).is_some() {
                            eprintln!("[CHAIN_FORWARD] pending remplacé key={}", key);
                        }
                        (before, guard.len())
                    };
                    let body = serde_json::json!({
                        "routing_path": [final_str],
                        "result_peer": my_peer_id_chain_axum.to_string(),
                        "final_peer": final_str,
                        "forward_dtype": forward_dtype,
                        "payload_b64": general_purpose::STANDARD.encode(&data),
                        "payload_len": data.len(),
                        "chain_type": payload.get("chain_type").cloned().unwrap_or_else(|| serde_json::json!("CHAIN_FORWARD")),
                        "microbatch_id": microbatch_id,
                        "token_start": token_start,
                        "token_count": token_count,
                    });
                    let frame = PipelineFrame {
                        frame_type: PIPELINE_FRAME_REQUEST,
                        request_id: request_id.clone(),
                        session_id: session_id.clone(),
                        step_id,
                        dtype: chain_frame_dtype.clone(),
                        payload: serde_json::to_vec(&body).unwrap_or_default(),
                    };
                    let ack_started = Instant::now();
                    let ack_result = tokio::time::timeout(
                        chain_forward_ack_timeout(),
                        pipeline_stream_roundtrip(control, cache, target_peer, frame, pipeline_stream_ttl_direct_axum),
                    )
                    .await;
                    let chain_ack_ms = ack_started.elapsed().as_millis() as u64;
                    let ack_trace;
                    match ack_result {
                        Ok(Ok((ack_frame, trace))) => {
                            ack_trace = trace;
                            let ack_json = serde_json::from_slice::<serde_json::Value>(&ack_frame.payload)
                                .unwrap_or_else(|_| serde_json::json!({"ok": false, "error": "bad_chain_forward_ack_json"}));
                            if ack_json.get("ok").and_then(|v| v.as_bool()) != Some(true) {
                                let pending_count_after = {
                                    let mut guard = pending_results.lock().await;
                                    guard.remove(&key);
                                    guard.len()
                                };
                                return (
                                    axum::http::StatusCode::BAD_GATEWAY,
                                    Json(serde_json::json!({
                                        "ok": false,
                                        "error": ack_json.get("error").and_then(|v| v.as_str()).unwrap_or("chain_forward_ack_error"),
                                        "chain_fallback_reason": "chain_forward_ack_error",
                                        "request_response_fallback": true,
                                        "relay_trace": {
                                            "request_id": request_id,
                                            "session_id": session_id,
                                            "step_id": step_id,
                                            "pending_key": key,
                                            "pending_count_before": pending_count_before,
                                            "pending_count_after": pending_count_after,
                                            "chain_pending_count": pending_count_after_insert,
                                            "chain_ack_ms": chain_ack_ms,
                                            "failed_step_id": step_id,
                                            "failed_stage": "chain_forward_ack_error",
                                            "failed_peer": target_peer.to_string(),
                                            "transport_error_detail": ack_json.get("error").and_then(|v| v.as_str()).unwrap_or("chain_forward_ack_error"),
                                            "stream_closed": true
                                        },
                                    })),
                                );
                            }
                        }
                        Ok(Err(e)) => {
                            let pending_count_after = {
                                let mut guard = pending_results.lock().await;
                                guard.remove(&key);
                                guard.len()
                            };
                            return (
                                axum::http::StatusCode::SERVICE_UNAVAILABLE,
                                Json(serde_json::json!({
                                    "ok": false,
                                    "error": e,
                                    "chain_fallback_reason": "chain_forward_failed",
                                    "request_response_fallback": true,
                                    "relay_trace": {
                                        "request_id": request_id,
                                        "session_id": session_id,
                                        "step_id": step_id,
                                        "pending_key": key,
                                        "pending_count_before": pending_count_before,
                                        "pending_count_after": pending_count_after,
                                        "chain_pending_count": pending_count_after_insert,
                                        "chain_ack_ms": chain_ack_ms,
                                        "failed_step_id": step_id,
                                        "failed_stage": "chain_forward_send",
                                        "failed_peer": target_peer.to_string(),
                                        "transport_error_detail": e,
                                        "stream_closed": true
                                    },
                                })),
                            );
                        }
                        Err(_) => {
                            let pending_count_after = {
                                let mut guard = pending_results.lock().await;
                                guard.remove(&key);
                                guard.len()
                            };
                            return (
                                axum::http::StatusCode::GATEWAY_TIMEOUT,
                                Json(serde_json::json!({
                                    "ok": false,
                                    "error": "chain_forward_ack_timeout",
                                    "chain_fallback_reason": "chain_forward_ack_timeout",
                                    "request_response_fallback": true,
                                    "relay_trace": {
                                        "request_id": request_id,
                                        "session_id": session_id,
                                        "step_id": step_id,
                                        "pending_key": key,
                                        "pending_count_before": pending_count_before,
                                        "pending_count_after": pending_count_after,
                                        "chain_pending_count": pending_count_after_insert,
                                        "chain_ack_ms": chain_ack_ms,
                                        "failed_step_id": step_id,
                                        "failed_stage": "chain_forward_ack_timeout",
                                        "failed_peer": target_peer.to_string(),
                                        "transport_error_detail": "chain_forward_ack_timeout",
                                        "stream_closed": true
                                    },
                                })),
                            );
                        }
                    }
                    let wait_started = Instant::now();
                    let result_timeout = std::cmp::min(chain_result_timeout(), chain_total_step_timeout());
                    let result_json = match tokio::time::timeout(result_timeout, rx).await {
                        Ok(Ok(value)) => value,
                        Ok(Err(_)) => {
                            let pending_count_after = {
                                let mut guard = pending_results.lock().await;
                                guard.remove(&key);
                                guard.len()
                            };
                            return (
                                axum::http::StatusCode::GATEWAY_TIMEOUT,
                                Json(serde_json::json!({
                                    "ok": false,
                                    "error": "chain_result_waiter_closed",
                                    "chain_fallback_reason": "chain_result_waiter_closed",
                                    "request_response_fallback": true,
                                    "relay_trace": {
                                        "request_id": request_id,
                                        "session_id": session_id,
                                        "step_id": step_id,
                                        "pending_key": key,
                                        "pending_count_before": pending_count_before,
                                        "pending_count_after": pending_count_after,
                                        "chain_pending_count": pending_count_after_insert,
                                        "chain_ack_ms": chain_ack_ms,
                                        "chain_result_wait_ms": wait_started.elapsed().as_millis() as u64,
                                        "failed_step_id": step_id,
                                        "failed_stage": "chain_result_waiter_closed",
                                        "failed_peer": final_str,
                                        "transport_error_detail": "chain_result_waiter_closed",
                                        "stream_closed": true
                                    },
                                })),
                            );
                        }
                        Err(_) => {
                            let pending_count_after = {
                                let mut guard = pending_results.lock().await;
                                guard.remove(&key);
                                guard.len()
                            };
                            return (
                                axum::http::StatusCode::GATEWAY_TIMEOUT,
                                Json(serde_json::json!({
                                    "ok": false,
                                    "error": "chain_result_timeout",
                                    "chain_fallback_reason": "chain_result_timeout",
                                    "request_response_fallback": true,
                                    "relay_trace": {
                                        "chain_ack_ms": chain_ack_ms,
                                        "chain_result_wait_ms": wait_started.elapsed().as_millis() as u64,
                                        "pending_key": key,
                                        "pending_count_before": pending_count_before,
                                        "pending_count_after": pending_count_after,
                                        "chain_pending_count": pending_count_after_insert,
                                        "failed_step_id": step_id,
                                        "failed_stage": "chain_result_timeout",
                                        "failed_peer": final_str,
                                        "transport_error_detail": "chain_result_timeout",
                                        "stream_closed": true
                                    },
                                })),
                            );
                        }
                    };
                    let chain_result_wait_ms = wait_started.elapsed().as_millis() as u64;
                    let pending_count_after_result = pending_results.lock().await.len();
                    if result_json.get("ok").and_then(|v| v.as_bool()) != Some(true) {
                        return (
                            axum::http::StatusCode::BAD_GATEWAY,
                            Json(serde_json::json!({
                                "ok": false,
                                "error": result_json.get("error").and_then(|v| v.as_str()).unwrap_or("chain_result_error"),
                                "chain_fallback_reason": "chain_result_error",
                                "request_response_fallback": true,
                                "chain_result": result_json,
                                "relay_trace": {
                                    "request_id": request_id,
                                    "session_id": session_id,
                                    "step_id": step_id,
                                    "pending_key": key,
                                    "pending_count_before": pending_count_before,
                                    "pending_count_after": pending_count_after_result,
                                    "chain_pending_count": pending_count_after_insert,
                                    "chain_ack_ms": chain_ack_ms,
                                    "chain_result_wait_ms": chain_result_wait_ms,
                                    "failed_step_id": step_id,
                                    "failed_stage": "chain_result_error",
                                    "failed_peer": result_json.get("from_peer").and_then(|v| v.as_str()).unwrap_or(final_str),
                                    "transport_error_detail": result_json.get("error").and_then(|v| v.as_str()).unwrap_or("chain_result_error"),
                                    "stream_closed": false
                                },
                            })),
                        );
                    }
                    if result_json.get("is_fake_tensor").and_then(|v| v.as_bool()) == Some(true) {
                        let trace_json = serde_json::json!({
                            "dtype": forward_dtype,
                            "method": "vryx.chain.forward",
                            "protocol": PIPELINE_STREAM_PROTOCOL,
                            "transport": "pipeline_stream_chain_result_direct",
                            "p2p_transport": "pipeline_stream",
                            "peer_id": target_peer.to_string(),
                            "request_id": request_id,
                            "session_id": session_id,
                            "step_id": step_id,
                            "chain_forward_ms": started.elapsed().as_millis() as u64,
                            "chain_ack_ms": chain_ack_ms,
                            "chain_result_wait_ms": chain_result_wait_ms,
                            "vps_chain_result_received_ms": unix_ms(),
                            "pending_key": key,
                            "pending_count_before": pending_count_before,
                            "pending_count_after": pending_count_after_result,
                            "m1_chain_received_ms": result_json.get("m1_chain_received_ms").cloned().unwrap_or(serde_json::Value::Null),
                            "m1_grpc_compute_start_ms": result_json.get("m1_grpc_compute_start_ms").cloned().unwrap_or(serde_json::Value::Null),
                            "m1_grpc_compute_end_ms": result_json.get("m1_grpc_compute_end_ms").cloned().unwrap_or(serde_json::Value::Null),
                            "m1_forward_to_m4_start_ms": result_json.get("m1_forward_to_m4_start_ms").cloned().unwrap_or(serde_json::Value::Null),
                            "m1_compute_ms": result_json.get("m1_grpc_compute_end_ms").and_then(|v| v.as_u64()).unwrap_or(0).saturating_sub(result_json.get("m1_grpc_compute_start_ms").and_then(|v| v.as_u64()).unwrap_or(0)),
                            "m4_compute_ms": result_json.get("compute_ms").and_then(|v| v.as_u64()).unwrap_or(0),
                            "m4_chain_received_ms": result_json.get("m4_chain_received_ms").cloned().unwrap_or(serde_json::Value::Null),
                            "m4_grpc_compute_start_ms": result_json.get("m4_grpc_compute_start_ms").cloned().unwrap_or(serde_json::Value::Null),
                            "m4_grpc_compute_end_ms": result_json.get("m4_grpc_compute_end_ms").cloned().unwrap_or(serde_json::Value::Null),
                            "m4_chain_result_send_ms": result_json.get("m4_chain_result_send_ms").cloned().unwrap_or(serde_json::Value::Null),
                            "chain_result_direct": true,
                            "chain_type": result_json.get("chain_type").and_then(|v| v.as_str()).unwrap_or("CHAIN_RESULT"),
                            "coalesced": result_json.get("coalesced").and_then(|v| v.as_bool()).unwrap_or(false),
                            "microbatch_id": result_json.get("microbatch_id").and_then(|v| v.as_str()),
                            "token_start": result_json.get("token_start").and_then(|v| v.as_u64()),
                            "token_count": result_json.get("token_count").and_then(|v| v.as_u64()),
                            "accepted_token_count": result_json.get("accepted_token_count").and_then(|v| v.as_u64()),
                            "chain_hop_count": result_json.get("chain_hop_count").and_then(|v| v.as_u64()).unwrap_or(1),
                            "batch_hop_count": result_json.get("batch_hop_count").and_then(|v| v.as_u64()).unwrap_or(1),
                            "batch_m1_compute_ms": result_json.get("batch_m1_compute_ms").and_then(|v| v.as_u64()),
                            "batch_m4_compute_ms": result_json.get("batch_m4_compute_ms").and_then(|v| v.as_u64()),
                            "batch_chain_forward_ms": started.elapsed().as_millis() as u64,
                            "batch_result_wait_ms": result_json.get("batch_result_wait_ms").and_then(|v| v.as_u64()),
                            "batch_tokens_per_second": result_json.get("batch_tokens_per_second").and_then(|v| v.as_f64()),
                            "chain_result_from_peer": result_json.get("from_peer").and_then(|v| v.as_str()),
                            "chain_pending_count": pending_count_after_insert,
                            "stream_open_ms": ack_trace.stream_open_ms,
                            "stream_reused": ack_trace.stream_reused,
                            "stream_send_ms": ack_trace.stream_send_ms,
                            "stream_wait_response_ms": ack_trace.stream_wait_response_ms,
                            "stream_roundtrip_ms": ack_trace.stream_roundtrip_ms,
                            "request_response_fallback": false,
                            "frames_sent": ack_trace.frames_sent + 1,
                            "frames_received": ack_trace.frames_received + 1,
                            "stream_closed": false,
                        });
                        return (
                            axum::http::StatusCode::OK,
                            Json(serde_json::json!({
                                "ok": true,
                                "data": result_json,
                                "relay_ms": started.elapsed().as_millis() as u64,
                                "pipeline_stream": true,
                                "chain_result_direct": true,
                                "request_response_fallback": false,
                                "pipeline_stream_trace": trace_json,
                                "relay_trace": trace_json,
                            })),
                        );
                    }
                    let payload_b64 = result_json.get("payload_b64").and_then(|v| v.as_str()).unwrap_or("");
                    let payload_bytes = match general_purpose::STANDARD.decode(payload_b64) {
                        Ok(bytes) => bytes,
                        Err(e) => {
                            return (
                                axum::http::StatusCode::BAD_GATEWAY,
                                Json(serde_json::json!({
                                    "ok": false,
                                    "error": format!("chain_result_payload_b64: {}", e),
                                    "relay_trace": {
                                        "request_id": request_id,
                                        "session_id": session_id,
                                        "step_id": step_id,
                                        "pending_key": key,
                                        "pending_count_before": pending_count_before,
                                        "pending_count_after": pending_count_after_result,
                                        "failed_step_id": step_id,
                                        "failed_stage": "chain_result_payload_decode",
                                        "failed_peer": result_json.get("from_peer").and_then(|v| v.as_str()).unwrap_or(final_str),
                                        "transport_error_detail": format!("chain_result_payload_b64: {}", e),
                                        "stream_closed": false
                                    }
                                })),
                            );
                        }
                    };
                    let resp = match serde_json::from_slice::<TensorResponse>(&payload_bytes) {
                        Ok(resp) => resp,
                        Err(e) => {
                            return (
                                axum::http::StatusCode::BAD_GATEWAY,
                                Json(serde_json::json!({
                                    "ok": false,
                                    "error": format!("chain_result_tensor_decode_failed: {}", e),
                                    "relay_trace": {
                                        "request_id": request_id,
                                        "session_id": session_id,
                                        "step_id": step_id,
                                        "pending_key": key,
                                        "pending_count_before": pending_count_before,
                                        "pending_count_after": pending_count_after_result,
                                        "failed_step_id": step_id,
                                        "failed_stage": "chain_result_tensor_decode",
                                        "failed_peer": result_json.get("from_peer").and_then(|v| v.as_str()).unwrap_or(final_str),
                                        "transport_error_detail": format!("chain_result_tensor_decode_failed: {}", e),
                                        "stream_closed": false
                                    }
                                })),
                            );
                        }
                    };
                    let data_b64 = general_purpose::STANDARD.encode(&resp.data);
                    let worker_trace = serde_json::from_str::<serde_json::Value>(&resp.relay_trace_json)
                        .unwrap_or_else(|_| serde_json::json!({}));
                    let trace_json = serde_json::json!({
                        "dtype": forward_dtype,
                        "method": "vryx.chain.forward",
                        "protocol": PIPELINE_STREAM_PROTOCOL,
                        "transport": "pipeline_stream_chain_result_direct",
                        "p2p_transport": "pipeline_stream",
                        "peer_id": target_peer.to_string(),
                        "request_id": request_id,
                        "session_id": session_id,
                        "step_id": step_id,
                        "payload_bytes": payload_bytes.len(),
                        "axum_ms": started.elapsed().as_millis() as u64,
                        "chain_forward_ms": started.elapsed().as_millis() as u64,
                        "chain_ack_ms": chain_ack_ms,
                        "chain_result_wait_ms": chain_result_wait_ms,
                        "chain_result_direct": true,
                        "chain_result_from_peer": result_json.get("from_peer").and_then(|v| v.as_str()),
                        "pending_key": key,
                        "pending_count_before": pending_count_before,
                        "pending_count_after": pending_count_after_result,
                        "chain_pending_count": pending_count_after_insert,
                        "m1_compute_ms": result_json.get("m1_grpc_compute_end_ms").and_then(|v| v.as_u64()).unwrap_or(0).saturating_sub(result_json.get("m1_grpc_compute_start_ms").and_then(|v| v.as_u64()).unwrap_or(0)),
                        "m4_compute_ms": resp.worker_compute_ms,
                        "stream_open_ms": ack_trace.stream_open_ms,
                        "stream_reused": ack_trace.stream_reused,
                        "stream_send_ms": ack_trace.stream_send_ms,
                        "stream_wait_response_ms": ack_trace.stream_wait_response_ms,
                        "stream_roundtrip_ms": ack_trace.stream_roundtrip_ms,
                        "request_response_fallback": false,
                        "frames_sent": ack_trace.frames_sent + 1,
                        "frames_received": ack_trace.frames_received + 1,
                        "stream_closed": false,
                        "worker_seen_request": true,
                        "worker_transport_trace": worker_trace,
                    });
                    (
                        axum::http::StatusCode::OK,
                        Json(serde_json::json!({
                            "ok": true,
                            "data_b64": data_b64,
                            "relay_ms": started.elapsed().as_millis() as u64,
                            "serialization_ms": resp.serialization_time_ns / 1_000_000,
                            "hidden_bytes": resp.p2p_messages_in,
                            "persistent_relay": true,
                            "connection_reuse": ack_trace.stream_reused,
                            "connection_transport": PIPELINE_STREAM_PROTOCOL,
                            "prompt_tokens": resp.prompt_tokens_llm,
                            "completion_tokens": resp.completion_tokens_llm,
                            "total_tokens": resp.total_tokens_llm,
                            "vps_delegate_ms": started.elapsed().as_millis() as u64,
                            "worker_compute_ms": resp.worker_compute_ms,
                            "compute_time_ms": resp.compute_time_ms,
                            "shard_session_id": resp.shard_session_id,
                            "pipeline_stream": true,
                            "chain_result_direct": true,
                            "request_response_fallback": false,
                            "pipeline_stream_trace": trace_json,
                            "relay_trace": trace_json,
                        })),
                    )
                }
            }))
            .route("/api/p2p/chain-test", post(move |Json(payload): Json<serde_json::Value>| {
                let control = Arc::clone(&pipeline_stream_control_chain_axum);
                let cache = Arc::clone(&pipeline_stream_cache_chain_axum);
                let mode_chain_stream_call = mode_chain_stream.clone();
                async move {
                    use base64::{Engine as _, engine::general_purpose};
                    let started = Instant::now();
                    if mode_chain_stream_call != "initiator" {
                        return (
                            axum::http::StatusCode::FORBIDDEN,
                            Json(serde_json::json!({"ok": false, "error": "Chain stream : mode initiateur requis."})),
                        );
                    }
                    let source_str = payload.get("source_peer").and_then(|v| v.as_str()).unwrap_or("");
                    let target_str = payload.get("target_peer").and_then(|v| v.as_str()).unwrap_or("");
                    let source_peer: PeerId = match PeerId::from_str(source_str) {
                        Ok(p) => p,
                        Err(_) => {
                            return (
                                axum::http::StatusCode::BAD_REQUEST,
                                Json(serde_json::json!({"ok": false, "error": "source_peer libp2p invalide."})),
                            );
                        }
                    };
                    if PeerId::from_str(target_str).is_err() {
                        return (
                            axum::http::StatusCode::BAD_REQUEST,
                            Json(serde_json::json!({"ok": false, "error": "target_peer libp2p invalide."})),
                        );
                    }
                    let test = payload
                        .get("test")
                        .and_then(|v| v.as_str())
                        .unwrap_or("ping")
                        .trim()
                        .to_lowercase();
                    let dtype = match test.as_str() {
                        "hello" => "vryx.chain.hello",
                        "ready" => "vryx.chain.ready",
                        "ping" => "vryx.chain.ping",
                        "echo" => "vryx.chain.echo",
                        "fake_tensor" | "tensor" => "vryx.chain.fake_tensor",
                        _ => {
                            return (
                                axum::http::StatusCode::BAD_REQUEST,
                                Json(serde_json::json!({"ok": false, "error": "chain_test_type_not_allowed"})),
                            );
                        }
                    }
                    .to_string();
                    let payload_len = payload
                        .get("payload_bytes")
                        .and_then(|v| v.as_u64().or_else(|| v.as_i64().and_then(|i| if i >= 0 { Some(i as u64) } else { None })))
                        .unwrap_or(0)
                        .min(8 * 1024 * 1024) as usize;
                    let payload_bytes = vec![b'v'; payload_len];
                    let session_id = payload
                        .get("session_id")
                        .and_then(|v| v.as_str())
                        .unwrap_or("chain-smoke")
                        .to_string();
                    let request_id = payload
                        .get("request_id")
                        .and_then(|v| v.as_str())
                        .map(|s| s.to_string())
                        .unwrap_or_else(|| format!("chain-{}", started.elapsed().as_nanos()));
                    let body = serde_json::json!({
                        "routing_path": [target_str],
                        "payload_b64": general_purpose::STANDARD.encode(&payload_bytes),
                        "payload_bytes": payload_len,
                        "checksum": bytes_checksum(&payload_bytes),
                        "tensor_dtype": payload.get("tensor_dtype").and_then(|v| v.as_str()).unwrap_or("fp16"),
                        "shape": payload.get("shape").cloned().unwrap_or_else(|| serde_json::json!([1, payload_len])),
                    });
                    let frame = PipelineFrame {
                        frame_type: PIPELINE_FRAME_REQUEST,
                        request_id: request_id.clone(),
                        session_id: session_id.clone(),
                        step_id: payload
                            .get("step_id")
                            .and_then(|v| v.as_u64().or_else(|| v.as_i64().and_then(|i| if i >= 0 { Some(i as u64) } else { None })))
                            .unwrap_or(0),
                        dtype: dtype.clone(),
                        payload: serde_json::to_vec(&body).unwrap_or_default(),
                    };
                    match pipeline_stream_roundtrip(control, cache, source_peer, frame, pipeline_stream_ttl_chain_axum).await {
                        Ok((response_frame, trace)) => {
                            let response_json = serde_json::from_slice::<serde_json::Value>(&response_frame.payload)
                                .unwrap_or_else(|_| serde_json::json!({"ok": false, "chain_type": "CHAIN_ERROR", "error": "bad_chain_response_json"}));
                            let ok = response_json.get("ok").and_then(|v| v.as_bool()).unwrap_or(false);
                            (
                                if ok { axum::http::StatusCode::OK } else { axum::http::StatusCode::BAD_GATEWAY },
                                Json(serde_json::json!({
                                    "ok": ok,
                                    "test": test,
                                    "dtype": dtype,
                                    "source_peer": source_str,
                                    "target_peer": target_str,
                                    "payload_bytes": payload_len,
                                    "latency_ms": started.elapsed().as_millis() as u64,
                                    "chain_deadlock_guard_ms": pipeline_frame_deadline().as_millis() as u64,
                                    "chain_open_ms": trace.stream_open_ms,
                                    "chain_handshake_ms": trace.stream_open_ms,
                                    "chain_send_ms": trace.stream_send_ms,
                                    "chain_wait_ms": trace.stream_wait_response_ms,
                                    "chain_roundtrip_ms": trace.stream_roundtrip_ms,
                                    "chain_payload_bytes": payload_len,
                                    "stream_reused": trace.stream_reused,
                                    "frames_sent": trace.frames_sent,
                                    "frames_received": trace.frames_received,
                                    "response": response_json,
                                })),
                            )
                        }
                        Err(e) => (
                            axum::http::StatusCode::SERVICE_UNAVAILABLE,
                            Json(serde_json::json!({
                                "ok": false,
                                "test": test,
                                "dtype": dtype,
                                "source_peer": source_str,
                                "target_peer": target_str,
                                "payload_bytes": payload_len,
                                "error": e,
                                "latency_ms": started.elapsed().as_millis() as u64,
                                "chain_deadlock_guard_ms": pipeline_frame_deadline().as_millis() as u64,
                            })),
                        ),
                    }
                }
            }))
            .route("/api/p2p/pipeline-stream", post(move |Json(payload): Json<serde_json::Value>| {
                let control = Arc::clone(&pipeline_stream_control_axum);
                let cache = Arc::clone(&pipeline_stream_cache_axum);
                let mode_pipeline_stream_call = mode_pipeline_stream.clone();
                async move {
                    use base64::{Engine as _, engine::general_purpose};
                    let axum_started = Instant::now();
                    if mode_pipeline_stream_call != "initiator" {
                        return (
                            axum::http::StatusCode::FORBIDDEN,
                            Json(serde_json::json!({"ok": false, "error": "Pipeline stream : mode initiateur requis."})),
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
                    if dtype != "vryx.shard.pipeline" && !dtype.starts_with("vryx.chain.") {
                        return (
                            axum::http::StatusCode::BAD_REQUEST,
                            Json(serde_json::json!({"ok": false, "error": "pipeline_stream_dtype_not_allowed"})),
                        );
                    }
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
                    let request_id = payload.get("request_id").and_then(|v| v.as_str()).unwrap_or("").to_string();
                    let step_id = payload
                        .get("step_id")
                        .and_then(|v| v.as_u64().or_else(|| v.as_i64().and_then(|i| if i >= 0 { Some(i as u64) } else { None })))
                        .unwrap_or(0);
                    let frame = PipelineFrame {
                        frame_type: PIPELINE_FRAME_REQUEST,
                        request_id: request_id.clone(),
                        session_id: session_id.clone(),
                        step_id,
                        dtype: dtype.clone(),
                        payload: data,
                    };
                    match tokio::time::timeout(
                        std::time::Duration::from_secs(3600),
                        pipeline_stream_roundtrip(control, cache, peer, frame, pipeline_stream_ttl_axum),
                    )
                    .await
                    {
                        Ok(Ok((response_frame, trace))) if dtype.starts_with("vryx.chain.") => {
                            let response_json = serde_json::from_slice::<serde_json::Value>(&response_frame.payload)
                                .unwrap_or_else(|_| serde_json::json!({"ok": false, "chain_type": "CHAIN_ERROR", "error": "bad_chain_response_json"}));
                            let ok = response_json.get("ok").and_then(|v| v.as_bool()).unwrap_or(false);
                            let trace_json = serde_json::json!({
                                "dtype": dtype,
                                "method": dtype,
                                "protocol": PIPELINE_STREAM_PROTOCOL,
                                "transport": "pipeline_stream",
                                "p2p_transport": "pipeline_stream",
                                "peer_id": peer.to_string(),
                                "request_id": request_id,
                                "session_id": session_id,
                                "step_id": step_id,
                                "payload_bytes": response_frame.payload.len(),
                                "axum_ms": axum_started.elapsed().as_millis() as u64,
                                "stream_open_ms": trace.stream_open_ms,
                                "stream_reused": trace.stream_reused,
                                "stream_send_ms": trace.stream_send_ms,
                                "stream_wait_response_ms": trace.stream_wait_response_ms,
                                "stream_roundtrip_ms": trace.stream_roundtrip_ms,
                                "request_response_fallback": trace.request_response_fallback,
                                "frames_sent": trace.frames_sent,
                                "frames_received": trace.frames_received,
                                "worker_seen_request": true,
                            });
                            (
                                if ok { axum::http::StatusCode::OK } else { axum::http::StatusCode::BAD_GATEWAY },
                                Json(serde_json::json!({
                                    "ok": ok,
                                    "data": response_json,
                                    "data_b64": general_purpose::STANDARD.encode(&response_frame.payload),
                                    "relay_ms": trace.stream_roundtrip_ms,
                                    "pipeline_stream": true,
                                    "request_response_fallback": false,
                                    "pipeline_stream_trace": trace_json,
                                    "relay_trace": trace_json,
                                })),
                            )
                        }
                        Ok(Ok((response_frame, trace))) => {
                            let resp = match serde_json::from_slice::<TensorResponse>(&response_frame.payload) {
                                Ok(resp) => resp,
                                Err(e) => {
                                    return (
                                        axum::http::StatusCode::BAD_GATEWAY,
                                        Json(serde_json::json!({
                                            "ok": false,
                                            "error": format!("pipeline_stream_response_decode_failed: {}", e),
                                            "request_response_fallback": true,
                                        })),
                                    );
                                }
                            };
                            let data_b64 = general_purpose::STANDARD.encode(&resp.data);
                            let worker_trace = serde_json::from_str::<serde_json::Value>(&resp.relay_trace_json)
                                .unwrap_or_else(|_| serde_json::json!({}));
                            let trace_json = serde_json::json!({
                                "dtype": dtype,
                                "method": dtype,
                                "protocol": PIPELINE_STREAM_PROTOCOL,
                                "transport": "pipeline_stream",
                                "p2p_transport": "pipeline_stream",
                                "peer_id": peer.to_string(),
                                "request_id": request_id,
                                "session_id": session_id,
                                "step_id": step_id,
                                "payload_bytes": response_frame.payload.len(),
                                "axum_ms": axum_started.elapsed().as_millis() as u64,
                                "stream_open_ms": trace.stream_open_ms,
                                "stream_reused": trace.stream_reused,
                                "stream_send_ms": trace.stream_send_ms,
                                "stream_wait_response_ms": trace.stream_wait_response_ms,
                                "stream_roundtrip_ms": trace.stream_roundtrip_ms,
                                "request_response_fallback": trace.request_response_fallback,
                                "frames_sent": trace.frames_sent,
                                "frames_received": trace.frames_received,
                                "worker_seen_request": true,
                                "worker_transport_trace": worker_trace,
                            });
                            (
                                axum::http::StatusCode::OK,
                                Json(serde_json::json!({
                                    "ok": true,
                                    "data_b64": data_b64,
                                    "relay_ms": trace.stream_roundtrip_ms,
                                    "serialization_ms": resp.serialization_time_ns / 1_000_000,
                                    "hidden_bytes": resp.p2p_messages_in,
                                    "persistent_relay": true,
                                    "connection_reuse": trace.stream_reused,
                                    "connection_transport": PIPELINE_STREAM_PROTOCOL,
                                    "quic_available": true,
                                    "quic_used": false,
                                    "prompt_tokens": resp.prompt_tokens_llm,
                                    "completion_tokens": resp.completion_tokens_llm,
                                    "total_tokens": resp.total_tokens_llm,
                                    "vps_delegate_ms": trace.stream_roundtrip_ms,
                                    "worker_compute_ms": resp.worker_compute_ms,
                                    "compute_time_ms": resp.compute_time_ms,
                                    "shard_session_id": resp.shard_session_id,
                                    "pipeline_stream": true,
                                    "request_response_fallback": false,
                                    "pipeline_stream_trace": trace_json,
                                    "relay_trace": trace_json,
                                })),
                            )
                        }
                        Ok(Err(e)) => (
                            axum::http::StatusCode::SERVICE_UNAVAILABLE,
                            Json(serde_json::json!({
                                "ok": false,
                                "error": e,
                                "request_response_fallback": true,
                                "relay_trace": {
                                    "dtype": dtype,
                                    "method": dtype,
                                    "protocol": PIPELINE_STREAM_PROTOCOL,
                                    "transport": "pipeline_stream",
                                    "peer_id": peer.to_string(),
                                    "request_id": request_id,
                                    "session_id": session_id,
                                    "step_id": step_id,
                                    "elapsed_ms": axum_started.elapsed().as_millis() as u64,
                                }
                            })),
                        ),
                        Err(_) => (
                            axum::http::StatusCode::GATEWAY_TIMEOUT,
                            Json(serde_json::json!({
                                "ok": false,
                                "error": "pipeline_stream_timeout",
                                "request_response_fallback": true,
                            })),
                        ),
                    }
                }
            }))
            .route("/api/p2p/relay", post(move |Json(payload): Json<serde_json::Value>| async move {
                use base64::{Engine as _, engine::general_purpose};
                let axum_started = Instant::now();
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
                let axum_request_payload_bytes = data_b64.len() as u64;
                let b64_decode_t0 = Instant::now();
                let data = match general_purpose::STANDARD.decode(data_b64) {
                    Ok(d) => d,
                    Err(e) => {
                        return (
                            axum::http::StatusCode::BAD_REQUEST,
                            Json(serde_json::json!({"ok": false, "error": format!("data_b64 : {}", e)})),
                        );
                    }
                };
                let axum_base64_decode_ms = b64_decode_t0.elapsed().as_millis() as u64;
                let session_id = payload.get("session_id").and_then(|v| v.as_str()).unwrap_or("").to_string();
                let request_id = payload.get("request_id").and_then(|v| v.as_str()).unwrap_or("").to_string();
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
                let req_dtype = req.dtype.clone();
                let req_session_id = req.session_id.clone();
                let req_payload_bytes = req.data.len();
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
                        let b64_encode_t0 = Instant::now();
                        let data_b64 = general_purpose::STANDARD.encode(&resp.data);
                        let axum_response_base64_encode_ms = b64_encode_t0.elapsed().as_millis() as u64;
                        let relay_trace = serde_json::from_str::<serde_json::Value>(&resp.relay_trace_json)
                            .unwrap_or(serde_json::json!({}));
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
                                "relay_trace": {
                                    "dtype": req_dtype,
                                    "method": req_dtype,
                                    "peer_id": peer.to_string(),
                                    "request_id": request_id,
                                    "session_id": req_session_id,
                                    "timeout_ms": 3600_u64 * 1000,
                                    "axum_total_ms": axum_started.elapsed().as_millis() as u64,
                                    "axum_base64_decode_ms": axum_base64_decode_ms,
                                    "axum_response_base64_encode_ms": axum_response_base64_encode_ms,
                                    "axum_request_payload_bytes": axum_request_payload_bytes,
                                    "axum_response_payload_bytes": data_b64.len(),
                                    "payload_bytes": req_payload_bytes,
                                    "route_mode": "initiator_http_relay",
                                    "transport": connection_transport,
                                    "p2p_transport": connection_transport,
                                    "connection_transport": connection_transport,
                                    "connection_reuse": connection_reuse,
                                    "worker_seen_request": true,
                                    "quic_used": relay_quic_used,
                                    "inner": relay_trace,
                                },
                            })),
                        )
                    }
                    Ok(Ok(Err(e))) => (
                        axum::http::StatusCode::BAD_GATEWAY,
                        Json(serde_json::json!({
                            "ok": false,
                            "error": e,
                            "relay_trace": {
                                "dtype": req_dtype,
                                "method": req_dtype,
                                "peer_id": peer.to_string(),
                                "request_id": request_id,
                                "session_id": req_session_id,
                                "timeout_ms": 3600_u64 * 1000,
                                "elapsed_ms": axum_started.elapsed().as_millis() as u64,
                                "payload_bytes": req_payload_bytes,
                                "route_mode": "initiator_http_relay",
                                "transport": connection_transport,
                                "p2p_transport": connection_transport,
                                "axum_ms": axum_started.elapsed().as_millis() as u64,
                                "libp2p_send_ms": serde_json::Value::Null,
                                "worker_seen_request": false,
                            },
                        })),
                    ),
                    Ok(Err(_)) => (
                        axum::http::StatusCode::INTERNAL_SERVER_ERROR,
                        Json(serde_json::json!({
                            "ok": false,
                            "error": "Réponse relais annulée.",
                            "relay_trace": {
                                "dtype": req_dtype,
                                "method": req_dtype,
                                "peer_id": peer.to_string(),
                                "request_id": request_id,
                                "session_id": req_session_id,
                                "timeout_ms": 3600_u64 * 1000,
                                "elapsed_ms": axum_started.elapsed().as_millis() as u64,
                                "payload_bytes": req_payload_bytes,
                                "route_mode": "initiator_http_relay",
                                "transport": connection_transport,
                                "p2p_transport": connection_transport,
                                "axum_ms": axum_started.elapsed().as_millis() as u64,
                                "libp2p_send_ms": serde_json::Value::Null,
                                "worker_seen_request": false,
                            },
                        })),
                    ),
                    Err(_) => (
                        axum::http::StatusCode::GATEWAY_TIMEOUT,
                        Json(serde_json::json!({
                            "ok": false,
                            "error": "Délai relais P2P dépassé.",
                            "relay_trace": {
                                "dtype": req_dtype,
                                "method": req_dtype,
                                "peer_id": peer.to_string(),
                                "request_id": request_id,
                                "session_id": req_session_id,
                                "timeout_ms": 3600_u64 * 1000,
                                "elapsed_ms": axum_started.elapsed().as_millis() as u64,
                                "payload_bytes": req_payload_bytes,
                                "route_mode": "initiator_http_relay",
                                "transport": connection_transport,
                                "p2p_transport": connection_transport,
                                "axum_ms": axum_started.elapsed().as_millis() as u64,
                                "libp2p_send_ms": serde_json::Value::Null,
                                "worker_seen_request": false,
                            },
                        })),
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

    let initiator_tty = args.mode == "initiator"
        && std::env::var("VRYX_INITIATOR_TTY").ok().as_deref() == Some("1");
    if initiator_tty {
        println!("[Vryx Chat] Tapez votre message et appuyez sur Entrée.");
        println!("[Vryx Chat] Attendez qu'un worker soit découvert avant d'écrire.");
        print!("> Vous : ");
        let _ = tokio::io::stdout().flush().await;
    } else if args.mode == "initiator" {
        println!(
            "[*] Initiateur headless — API http://127.0.0.1:{}",
            args.api_port
        );
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
            message: String,
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
                .any(|p| boot_cancel.is_none_or(|b| *p != b));
            has_non_boot_connected || registry_for_cancel.load(Ordering::Relaxed) > 0
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
                    let send_started = Instant::now();
                    let req_id = swarm
                        .behaviour_mut()
                        .request_response
                        .send_request(&peer, req);
                    let libp2p_send_request_ms = send_started.elapsed().as_millis() as u64;
                    pending_requests.insert(req_id, (req_clone, PendingMeta::P2pRelayReply {
                        reply_tx,
                        relay_started,
                        hidden_bytes,
                        persistent_relay,
                        connection_reuse,
                        axum_base64_decode_ms: 0,
                        axum_request_payload_bytes: 0,
                        libp2p_send_request_ms,
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
                    let send_started = Instant::now();
                    let req_id = swarm
                        .behaviour_mut()
                        .request_response
                        .send_request(&peer, req);
                    let libp2p_send_request_ms = send_started.elapsed().as_millis() as u64;
                    pending_requests.insert(req_id, (req_clone, PendingMeta::P2pRelayReply {
                        reply_tx,
                        relay_started,
                        hidden_bytes,
                        persistent_relay,
                        connection_reuse,
                        axum_base64_decode_ms: 0,
                        axum_request_payload_bytes: 0,
                        libp2p_send_request_ms,
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
                    let machine_info =
                        heartbeat_machine_info_with_network(machine_info, args.p2p_port);
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

                    // Tous les daemons apprennent les adresses relay publiées par l'API.
                    // L'initiateur en a besoin pour orchestrer ; les workers en ont besoin
                    // pour ouvrir un chain stream direct worker -> worker.
                    let record_registry = args.mode == "initiator";
                    initiator_pull_workers_from_api_now(
                        &mut swarm,
                        &http_client,
                        api_url,
                        bootstrap_peer_id,
                        args.bootstrap_node.as_ref(),
                        my_peer_id,
                        &mut discovered_peers,
                        &active_peers,
                        if record_registry { Some(&initiator_registry_workers) } else { None },
                        if record_registry { Some(&initiator_registry_worker_peers) } else { None },
                        "heartbeat",
                    )
                    .await;
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
                                            let send_started = Instant::now();
                                            let req_id_i = swarm
                                                .behaviour_mut()
                                                .request_response
                                                .send_request(&peer_id, r);
                                            let libp2p_send_request_ms =
                                                send_started.elapsed().as_millis() as u64;
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
                                                        axum_base64_decode_ms: 0,
                                                        axum_request_payload_bytes: 0,
                                                        libp2p_send_request_ms,
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

                // Identify : ajoute les adresses à Kademlia
                SwarmEvent::Behaviour(VryxBehaviourEvent::Identify(
                    identify::Event::Received { peer_id, info, .. },
                )) => {
                    println!("[P2P] Identify reçu de {} : addrs={:?} (observed={:?})", peer_id, info.listen_addrs, info.observed_addr);
                    let is_bootstrap = bootstrap_peer_id == Some(peer_id);
                    for addr in info.listen_addrs {
                        if !should_keep_identify_addr(&addr, filter_private_identify_addrs) {
                            if !is_bootstrap {
                                println!(
                                    "[P2P] Adresse filtrée pour {} : {}",
                                    peer_id, addr
                                );
                            }
                            continue;
                        }
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
                                        let send_started = Instant::now();
                                        let req_id_i = swarm
                                            .behaviour_mut()
                                            .request_response
                                            .send_request(&peer_id, r);
                                        let libp2p_send_request_ms =
                                            send_started.elapsed().as_millis() as u64;
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
                                                    axum_base64_decode_ms: 0,
                                                    axum_request_payload_bytes: 0,
                                                    libp2p_send_request_ms,
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
                    for peer_info in ok.peers {
                        let peer_id = peer_info.peer_id;
                        if Some(peer_id) == bootstrap_peer_id { continue; }
                        for addr in peer_info.addrs {
                            swarm.behaviour_mut().kad.add_address(&peer_id, addr.clone());
                            swarm.add_peer_address(peer_id, addr);
                        }
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
                            axum_base64_decode_ms,
                            axum_request_payload_bytes,
                            libp2p_send_request_ms,
                        })) => {
                            let mut response_with_metrics = response.clone();
                            response_with_metrics.vps_delegate_ms = relay_started.elapsed().as_millis() as u64;
                            response_with_metrics.p2p_messages_in = hidden_bytes;
                            if response_with_metrics.serialization_time_ns == 0 {
                                response_with_metrics.serialization_time_ns = response.serialization_time_ns;
                            }
                            let worker_transport_trace =
                                extract_transport_trace_from_response_data(&response.data);
                            response_with_metrics.relay_trace_json = serde_json::json!({
                                "libp2p_roundtrip_ms": response_with_metrics.vps_delegate_ms,
                                "libp2p_send_request_ms": libp2p_send_request_ms,
                                "axum_base64_decode_ms": axum_base64_decode_ms,
                                "axum_request_payload_bytes": axum_request_payload_bytes,
                                "hidden_payload_bytes": hidden_bytes,
                                "worker_transport_trace": worker_transport_trace,
                            })
                            .to_string();
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
