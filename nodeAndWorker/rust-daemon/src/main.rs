use anyhow::Result;
use base64::Engine as _;
use clap::Parser;
use futures::StreamExt;
use libp2p::{
    autonat, dcutr, identify, kad, mdns, noise,
    relay,
    request_response::{self, ProtocolSupport},
    swarm::{NetworkBehaviour, SwarmEvent},
    tcp, yamux, Multiaddr, PeerId, StreamProtocol,
};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::error::Error;
use std::path::PathBuf;
use std::sync::{atomic::{AtomicU64, Ordering}, Arc, Mutex};
use std::time::{Duration, Instant};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt};
use tokio::time;
use axum::{routing::{get, post}, Json, Router};
use tower_http::cors::CorsLayer;

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
    /// Vide ou `llm_delegate` : comportement historique.
    #[serde(default)]
    kind: String,
    #[serde(with = "base64_vec")]
    data: Vec<u8>,
    dtype: String,
    compute_time_ns: u64,
    serialization_time_ns: u64,
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
        }
    }
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
    request_response: request_response::json::Behaviour<TensorRequest, TensorResponse>,
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
use vryx::TensorData;

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
}

async fn call_local_inference(
    port: u16,
    data: Vec<u8>,
    dtype: String,
) -> Result<(Vec<u8>, u64, u64, LlmMetrics), Box<dyn Error>> {
    let mut client = InferenceServiceClient::connect(format!("http://127.0.0.1:{}", port))
        .await?
        .max_decoding_message_size(100 * 1024 * 1024)
        .max_encoding_message_size(100 * 1024 * 1024);

    let response = client
        .process(tonic::Request::new(TensorData {
            data,
            shape: vec![],
            dtype,
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
    };
    if m.total_tokens == 0 && (m.prompt_tokens > 0 || m.completion_tokens > 0) {
        m.total_tokens = m.prompt_tokens.saturating_add(m.completion_tokens);
    }
    Ok((
        response.data,
        response.compute_time_ns,
        response.serialization_time_ns,
        m,
    ))
}

// ============================================================
//  Heartbeat → API Vryx
// ============================================================

#[derive(Debug, Serialize)]
struct HeartbeatPayload {
    peer_id: String,
    mode: String,
    grpc_port: Option<u16>,
    p2p_port: Option<u16>,
    version: &'static str,
    user_id: Option<u64>,
    tokens_in: u64,
    tokens_out: u64,
    tokens_generated: u64,
    p2p_peers: usize,
    model: Option<String>,
}

async fn send_heartbeat(
    client: &reqwest::Client,
    api_url: &str,
    payload: &HeartbeatPayload,
) {
    let url = format!("{}/api/workers/heartbeat", api_url.trim_end_matches('/'));
    match client.post(&url).json(payload).send().await {
        Ok(r) if r.status().is_success() => {
            println!("[*] Heartbeat OK → {}", url);
        }
        Ok(r) => {
            eprintln!("[!] Heartbeat HTTP {} → {}", r.status(), url);
        }
        Err(e) => {
            eprintln!("[!] Heartbeat erreur : {}", e);
        }
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
            rr_config.set_request_timeout(Duration::from_secs(120));
            let request_response = request_response::json::Behaviour::new(
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
                config.max_circuit_duration = Duration::from_secs(600); // 10 min
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
        .with_swarm_config(|c| c.with_idle_connection_timeout(Duration::from_secs(120)))
        .build();

    swarm.listen_on(format!("/ip4/0.0.0.0/tcp/{}", args.p2p_port).parse()?)?;
    if args.mode == "bootstrap" {
        swarm.add_external_address(format!("/ip4/51.222.26.225/tcp/{}", args.p2p_port).parse()?);
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

    #[derive(Debug, Clone)]
    enum PendingMeta {
        Chat { retries: u32, target_peer: PeerId },
        ShardWarmup,
    }

    let mut pending_requests: HashMap<
        request_response::OutboundRequestId,
        (TensorRequest, PendingMeta),
    > = HashMap::new();

    type ChatApiTx = tokio::sync::oneshot::Sender<serde_json::Value>;

    #[derive(Debug)]
    enum ChatState {
        Idle,
        Generating {
            full_prompt: String,
            target_peer: PeerId,
            token_count: usize,
            generated_text: String,
            response_tx: Option<ChatApiTx>,
            request_started: Instant,
            scheduler_warmup_sent: u32,
            scheduler_workers_used: u32,
        },
    }
    let mut chat_state = ChatState::Idle;

    // ── Shared State (pour l'API Axum) ────────────────────────────────────
    let active_peers = Arc::new(Mutex::new(HashSet::<PeerId>::new()));
    let tokens_in = Arc::new(AtomicU64::new(0));
    let tokens_out = Arc::new(AtomicU64::new(0));
    let tokens_generated = Arc::new(AtomicU64::new(0));
    let last_shard_trace = Arc::new(Mutex::new(Option::<serde_json::Value>::None));

    // Channel pour envoyer des commandes chat via l'API (initiator seulement)
    // (Prompt, Response Sender)
    let (cmd_tx, mut cmd_rx) = tokio::sync::mpsc::unbounded_channel::<(String, Option<ChatApiTx>)>();

    // ── Lancement de l'API Axum (Dashboard local) ─────────────────────────
    {
        let active_peers = Arc::clone(&active_peers);
        let tokens_in = Arc::clone(&tokens_in);
        let tokens_out = Arc::clone(&tokens_out);
        let tokens_generated = Arc::clone(&tokens_generated);
        let last_shard_trace_axum = Arc::clone(&last_shard_trace);
        let my_peer_id_str = my_peer_id.to_string();
        let cmd_tx_axum = cmd_tx.clone();
        let mode = args.mode.clone();

        let app = Router::new()
            .route("/api/status", get(move || {
                let connections = active_peers.lock().unwrap().len();
                let t_in = tokens_in.load(Ordering::Relaxed);
                let t_out = tokens_out.load(Ordering::Relaxed);
                let t_gen = tokens_generated.load(Ordering::Relaxed);
                let shard = last_shard_trace_axum.lock().unwrap().clone();
                async move {
                    let mut j = serde_json::json!({
                        "peer_id": my_peer_id_str,
                        "active_connections": connections,
                        "tokens_in": t_in,
                        "tokens_out": t_out,
                        "tokens_generated": t_gen,
                    });
                    if let Some(obj) = j.as_object_mut() {
                        obj.insert("last_shard_trace".into(), shard.unwrap_or(serde_json::Value::Null));
                    }
                    Json(j)
                }
            }))
            .route("/api/chat", post(move |Json(payload): Json<serde_json::Value>| async move {
                if mode != "initiator" {
                    return (axum::http::StatusCode::FORBIDDEN, Json(serde_json::json!({"error": "Node not in initiator mode"})));
                }
                if let Some(prompt) = payload["prompt"].as_str() {
                    let (tx, rx) = tokio::sync::oneshot::channel();
                    let _ = cmd_tx_axum.send((prompt.to_string(), Some(tx)));
                    
                    match tokio::time::timeout(std::time::Duration::from_secs(90), rx).await {
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

    let mut stdin_lines = tokio::io::BufReader::new(tokio::io::stdin()).lines();

    // Channel pour les résultats d'inférence (évite de bloquer la boucle swarm)
    enum InferenceResult {
        Stage1 {
            peer_id: PeerId,
            data: Vec<u8>,
            c: u64,
            s: u64,
            full_prompt: String,
            /// `Some` = continuation (déjà extrait de l'état) ; `None` = premier tour (prendre `response_tx` sur `chat_state`).
            continuation_response_tx: Option<ChatApiTx>,
            generated_text: String,
            request_started: Instant,
        },
        Stage2 {
            channel: request_response::ResponseChannel<TensorResponse>,
            data: Vec<u8>,
            c: u64,
            s: u64,
            metrics: LlmMetrics,
        },
        Stage2Error {
            channel: request_response::ResponseChannel<TensorResponse>,
            message: String,
        },
        Error { 
            context: String, 
            message: String 
        },
    }
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<InferenceResult>();

    // ── Boucle principale ─────────────────────────────────────────────────
    loop {
        tokio::select! {
            // ── stdin : chat initiator ──────────────────────────────────
            maybe_line = cmd_rx.recv(), if args.mode == "initiator" => {
                let (line, resp_tx) = match maybe_line {
                    Some(l) => l,
                    None => continue,
                };
                if line.is_empty() { continue }

                if !matches!(chat_state, ChatState::Idle) {
                    println!("[!] Génération en cours, patientez…");
                    continue;
                }

                // Cherche un worker actif (exclut le bootstrap et les anciens peers Kad déconnectés)
                let active_snapshot = active_peers.lock().unwrap().clone();
                let worker = discovered_peers
                    .iter()
                    .filter(|p| Some(**p) != bootstrap_peer_id)
                    .find(|p| active_snapshot.contains(*p))
                    .copied();

                if let Some(peer) = worker {
                    let prompt = format!(
                        "<|system|>\nYou are a helpful assistant.</s>\n\
                         <|user|>\n{}</s>\n<|assistant|>\n",
                        line
                    );
                    print!("> Assistant : ");
                    tokio::io::stdout().flush().await?;

                    // Warmup multi-workers : shard_init éphémère vers d'autres pairs actifs (scheduler).
                    let mut scheduler_warmup_sent: u32 = 0;
                    let secondaries: Vec<PeerId> = discovered_peers
                        .iter()
                        .filter(|p| Some(**p) != bootstrap_peer_id && **p != peer)
                        .filter(|p| active_snapshot.contains(*p))
                        .take(2)
                        .copied()
                        .collect();
                    for (i, sp) in secondaries.iter().enumerate() {
                        let session_id = format!(
                            "warm-{}-{}",
                            std::time::SystemTime::now()
                                .duration_since(std::time::UNIX_EPOCH)
                                .map(|d| d.as_millis())
                                .unwrap_or(0),
                            i
                        );
                        let body = serde_json::json!({
                            "session_id": session_id,
                            "ttl_sec": 120_u32,
                            "layer_start": 0_u32,
                            "layer_end": 0_u32,
                            "model_tag": "ephemeral",
                        });
                        let req = TensorRequest {
                            kind: String::new(),
                            data: serde_json::to_vec(&body).unwrap_or_default(),
                            dtype: "vryx.shard.init".to_string(),
                            compute_time_ns: 0,
                            serialization_time_ns: 0,
                        };
                        let req_id = swarm
                            .behaviour_mut()
                            .request_response
                            .send_request(sp, req.clone());
                        pending_requests.insert(req_id, (req, PendingMeta::ShardWarmup));
                        scheduler_warmup_sent += 1;
                        println!("[P2P] Warmup shard_init -> {}", sp);
                    }
                    let scheduler_workers_used = 1_u32 + scheduler_warmup_sent;

                    let request_started = Instant::now();
                    let tx_stage1 = tx.clone();
                    let grpc_port = args.grpc_port;
                    let p_clone = prompt.clone();
                    tokio::spawn(async move {
                        match call_local_inference(grpc_port, p_clone.as_bytes().to_vec(), "text".to_string()).await {
                            Ok((data, c, s, _m)) => {
                                let _ = tx_stage1.send(InferenceResult::Stage1 {
                                    peer_id: peer,
                                    data,
                                    c,
                                    s,
                                    full_prompt: p_clone,
                                    continuation_response_tx: None,
                                    generated_text: String::new(),
                                    request_started,
                                });
                            }
                            Err(e) => {
                                let _ = tx_stage1.send(InferenceResult::Error {
                                    context: "Stage 1".to_string(),
                                    message: e.to_string(),
                                });
                            }
                        }
                    });
                    chat_state = ChatState::Generating {
                        full_prompt: prompt,
                        target_peer: peer,
                        token_count: 0,
                        generated_text: String::new(),
                        response_tx: resp_tx,
                        request_started,
                        scheduler_warmup_sent,
                        scheduler_workers_used,
                    };
                } else {
                    println!(
                        "[!] Aucun worker découvert pour l'instant. \
                         Attendez la connexion au bootstrap…"
                    );
                    if let Some(tx) = resp_tx {
                        let _ = tx.send(serde_json::json!({
                            "ok": false,
                            "error": "Aucun worker P2P découvert. Vérifiez qu'un nœud worker est en ligne."
                        }));
                    }
                    print!("> Vous : ");
                    tokio::io::stdout().flush().await?;
                }
            }

            // ── Résultats d'inférence (async) ──────────────────────────
            res = rx.recv() => {
                if let Some(result) = res {
                    match result {
                        InferenceResult::Stage1 { peer_id, data, c, s, full_prompt, continuation_response_tx, generated_text, request_started } => {
                            let (sched_warm, sched_workers) = match &chat_state {
                                ChatState::Generating {
                                    scheduler_warmup_sent,
                                    scheduler_workers_used,
                                    ..
                                } => (*scheduler_warmup_sent, *scheduler_workers_used),
                                _ => (0_u32, 1_u32),
                            };
                            let response_tx = continuation_response_tx.or_else(|| {
                                match &mut chat_state {
                                    ChatState::Generating { response_tx, .. } => response_tx.take(),
                                    _ => None,
                                }
                            });

                            let req = TensorRequest {
                                kind: String::new(),
                                data,
                                dtype: "hidden_states".to_string(),
                                compute_time_ns: c,
                                serialization_time_ns: s,
                            };
                            let req_id = swarm.behaviour_mut().request_response.send_request(&peer_id, req.clone());
                            pending_requests.insert(
                                req_id,
                                (req, PendingMeta::Chat {
                                    retries: 0,
                                    target_peer: peer_id,
                                }),
                            );
                            chat_state = ChatState::Generating {
                                full_prompt,
                                target_peer: peer_id,
                                token_count: 0,
                                generated_text,
                                response_tx,
                                request_started,
                                scheduler_warmup_sent: sched_warm,
                                scheduler_workers_used: sched_workers,
                            };
                            tokens_out.fetch_add(1, Ordering::Relaxed);
                        }
                        InferenceResult::Stage2 { channel, data, c, s, metrics } => {
                            let w_ms = c.saturating_div(1_000_000).max(1);
                            let _ = swarm.behaviour_mut().request_response.send_response(
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
                                    ..Default::default()
                                },
                            );
                            tokens_out.fetch_add(1, Ordering::Relaxed);
                            tokens_generated.fetch_add(1, Ordering::Relaxed);
                        }
                        InferenceResult::Stage2Error { channel, message } => {
                            eprintln!("[!] Inférence Stage 2 échouée : {}", message);
                            // Send an error response so the initiator doesn't get EOF
                            let _ = swarm.behaviour_mut().request_response.send_response(
                                channel,
                                TensorResponse {
                                    data: format!("ERROR: {}", message).into_bytes(),
                                    ..Default::default()
                                },
                            );
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
                if let Some(api_url) = &args.api_url {
                    let payload = HeartbeatPayload {
                        peer_id: my_peer_id.to_string(),
                        mode: args.mode.clone(),
                        grpc_port: if args.mode == "worker" { Some(args.grpc_port) } else { None },
                        p2p_port: if args.p2p_port > 0 { Some(args.p2p_port) } else { None },
                        version: env!("CARGO_PKG_VERSION"),
                        user_id: args.user_id,
                        tokens_in: tokens_in.load(Ordering::Relaxed),
                        tokens_out: tokens_out.load(Ordering::Relaxed),
                        tokens_generated: tokens_generated.load(Ordering::Relaxed),
                        p2p_peers: active_peers.lock().unwrap().len(),
                        model: model_name.clone(),
                    };
                    send_heartbeat(&http_client, api_url, &payload).await;

                    // Initiator: fallback robuste de découverte depuis les heartbeats API.
                    // Les workers peuvent être visibles en DB sans être encore découverts par Kademlia.
                    if args.mode == "initiator" {
                        let url = format!("{}/api/workers/status", api_url.trim_end_matches('/'));
                        if let Ok(resp) = http_client.get(&url).send().await {
                            if let Ok(body) = resp.json::<serde_json::Value>().await {
                                if let Some(workers) = body.get("workers").and_then(|v| v.as_array()) {
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

                                        if let Some(boot_addr) = &args.bootstrap_node {
                                            let relay_addr_str = format!("{}/p2p-circuit/p2p/{}", boot_addr, peer_id);
                                            if let Ok(relay_addr) = relay_addr_str.parse::<Multiaddr>() {
                                                swarm.behaviour_mut().kad.add_address(&peer_id, relay_addr.clone());
                                                if discovered_peers.insert(peer_id) {
                                                    println!("[P2P] Worker heartbeat ajouté : {}", peer_id);
                                                }
                                                if !active_peers.lock().unwrap().contains(&peer_id) {
                                                    if let Err(e) = swarm.dial(relay_addr.clone()) {
                                                        eprintln!("[!] Dial worker heartbeat {} échoué : {:?}", peer_id, e);
                                                    } else {
                                                        println!("[P2P] Dial worker heartbeat : {}", peer_id);
                                                    }
                                                }
                                            }
                                        }
                                    }
                                }
                            }
                        }
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
                        active_peers.lock().unwrap().insert(peer_id);
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
                    active_peers.lock().unwrap().remove(&peer_id);
                    if Some(peer_id) != bootstrap_peer_id {
                        discovered_peers.remove(&peer_id);
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
                        if !is_bootstrap {
                            println!("[P2P] Adresse ajoutée pour {} : {}", peer_id, addr);
                        }
                    }
                    if info.protocols.iter().any(|p| p.as_ref().starts_with("/vryx/")) {
                        if !is_bootstrap && discovered_peers.insert(peer_id) {
                            println!("[P2P] Vryx worker découvert (Identify) : {}", peer_id);
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
                    println!("[<] Requête P2P reçue de {}", peer);
                    tokens_in.fetch_add(1, Ordering::Relaxed);
                    let tx_stage2 = tx.clone();
                    let grpc_port = args.grpc_port;
                    let dtype_in = request.dtype.clone();
                    let trace_shard = Arc::clone(&last_shard_trace);
                    tokio::spawn(async move {
                        match call_local_inference(grpc_port, request.data, request.dtype).await {
                            Ok((data, c, s, metrics)) => {
                                if dtype_in.starts_with("vryx.shard.") {
                                    let _ = trace_shard.lock().unwrap().replace(serde_json::json!({
                                        "dtype": dtype_in,
                                        "shard_session_id": metrics.shard_session_id,
                                        "shard_layer_id": metrics.shard_layer_id,
                                        "ts_ms": std::time::SystemTime::now()
                                            .duration_since(std::time::UNIX_EPOCH)
                                            .map(|d| d.as_millis())
                                            .unwrap_or(0),
                                    }));
                                }
                                let _ = tx_stage2.send(InferenceResult::Stage2 {
                                    channel,
                                    data,
                                    c,
                                    s,
                                    metrics,
                                });
                            }
                            Err(e) => {
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
                        peer,
                        message: request_response::Message::Response { response, request_id },
                        ..
                    },
                )) => {
                    match pending_requests.remove(&request_id) {
                        Some((_, PendingMeta::ShardWarmup)) => {
                            println!("[P2P] Réponse warmup shard de {}", peer);
                            continue;
                        }
                        Some((_, PendingMeta::Chat { .. })) => {}
                        None => continue,
                    }

                    let mut maybe_next: Option<(String, PeerId, Option<ChatApiTx>, String, Instant)> = None;

                    if let ChatState::Generating {
                        ref mut full_prompt,
                        ref target_peer,
                        ref mut token_count,
                        ref mut generated_text,
                        ref mut response_tx,
                        request_started,
                        scheduler_warmup_sent: _,
                        scheduler_workers_used: _,
                    } = chat_state
                    {
                        if peer == *target_peer {
                            // Sécurité : on ne print que si c'est du texte lisible
                            if response.data.iter().all(|&b| b == 10 || b == 13 || (b >= 32 && b <= 126) || b >= 128) {
                                let token_final = String::from_utf8_lossy(&response.data);
                                print!("{}", token_final);
                                let _ = tokio::io::stdout().flush().await;
                                full_prompt.push_str(&token_final);
                                generated_text.push_str(&token_final);

                                // Ollama renvoie une réponse complète dès le premier tour P2P.
                                // On s'arrête après le 1er aller-retour (ou sur marqueur de fin).
                                let done = true;
                                if !done {
                                    *token_count += 1;
                                    let next_resp_tx = response_tx.take();
                                    let next_gen_text = generated_text.clone();
                                    maybe_next = Some((
                                        full_prompt.clone(),
                                        *target_peer,
                                        next_resp_tx,
                                        next_gen_text,
                                        request_started,
                                    ));
                                } else {
                                    println!("\n");
                                    let peer_str = target_peer.to_string();
                                    let started = request_started;
                                    let (sched_w, sched_u) = match &chat_state {
                                        ChatState::Generating {
                                            scheduler_warmup_sent,
                                            scheduler_workers_used,
                                            ..
                                        } => (*scheduler_warmup_sent, *scheduler_workers_used),
                                        _ => (0_u32, 1_u32),
                                    };
                                    if let ChatState::Generating { response_tx, generated_text, .. } =
                                        std::mem::replace(&mut chat_state, ChatState::Idle)
                                    {
                                        if let Some(tx) = response_tx {
                                            let latency_ms = started.elapsed().as_millis() as u64;
                                            tokens_generated.fetch_add(1, Ordering::Relaxed);
                                            let pt = response.prompt_tokens_llm;
                                            let ct = response.completion_tokens_llm;
                                            let tt = if response.total_tokens_llm > 0 {
                                                response.total_tokens_llm
                                            } else {
                                                pt.saturating_add(ct)
                                            };
                                            let _ = tx.send(serde_json::json!({
                                                "ok": true,
                                                "response": generated_text,
                                                "worker_peer_id": peer_str,
                                                "latency_ms": latency_ms,
                                                "prompt_tokens": pt,
                                                "completion_tokens": ct,
                                                "total_tokens": tt,
                                                "vps_delegate_ms": response.vps_delegate_ms,
                                                "worker_compute_ms": response.worker_compute_ms,
                                                "p2p_messages_in": 1_u64,
                                                "p2p_messages_out": 1_u64,
                                                "tokens_in": 1,
                                                "tokens_out": 1,
                                                "tokens_generated": 1,
                                                "cumulative_tokens_in": tokens_in.load(Ordering::Relaxed),
                                                "cumulative_tokens_out": tokens_out.load(Ordering::Relaxed),
                                                "cumulative_tokens_generated": tokens_generated.load(Ordering::Relaxed),
                                                "shard_session_id": response.shard_session_id,
                                                "scheduler_warmup_sent": sched_w,
                                                "scheduler_workers_used": sched_u,
                                            }));
                                        }
                                    }
                                }
                            }
                        }
                    }

                    if let Some((prompt, target, resp_tx, gen_text, req_started)) = maybe_next {
                        let tx_next = tx.clone();
                        let grpc_port = args.grpc_port;
                        let p_clone = prompt.clone();
                        tokio::spawn(async move {
                            match call_local_inference(grpc_port, p_clone.as_bytes().to_vec(), "text".to_string()).await {
                                Ok((data, c, s, _m)) => {
                                    let _ = tx_next.send(InferenceResult::Stage1 {
                                        peer_id: target,
                                        data,
                                        c,
                                        s,
                                        full_prompt: p_clone,
                                        continuation_response_tx: resp_tx,
                                        generated_text: gen_text,
                                        request_started: req_started,
                                    });
                                }
                                Err(e) => {
                                    let _ = tx_next.send(InferenceResult::Error {
                                        context: "Stage 1 (auto-next)".to_string(),
                                        message: e.to_string(),
                                    });
                                }
                            }
                        });
                    } else if !matches!(chat_state, ChatState::Idle) {
                        chat_state = ChatState::Idle;
                        print!("> Vous : ");
                        let _ = tokio::io::stdout().flush().await;
                    }
                }

                // Échec d'envoi → retry sur un autre worker
                SwarmEvent::Behaviour(VryxBehaviourEvent::RequestResponse(
                    request_response::Event::OutboundFailure {
                        peer, request_id, error, ..
                    },
                )) => {
                    eprintln!("[!] Échec envoi vers {} : {}", peer, error);
                    if let Some((req, meta)) = pending_requests.remove(&request_id) {
                        let (retries, _target_peer) = match meta {
                            PendingMeta::ShardWarmup => {
                                eprintln!("[P2P] Warmup shard échoué vers {}", peer);
                                continue;
                            }
                            PendingMeta::Chat {
                                retries,
                                target_peer,
                            } => (retries, target_peer),
                        };
                        if retries < 2 {
                            discovered_peers.remove(&peer);
                            active_peers.lock().unwrap().remove(&peer);
                            let active_snapshot = active_peers.lock().unwrap().clone();
                            let alt = discovered_peers
                                .iter()
                                .filter(|p| Some(**p) != bootstrap_peer_id && **p != peer)
                                .find(|p| active_snapshot.contains(*p))
                                .copied();
                            if let Some(next_peer) = alt {
                                let new_id = swarm
                                    .behaviour_mut()
                                    .request_response
                                    .send_request(&next_peer, req.clone());
                                pending_requests.insert(
                                    new_id,
                                    (
                                        req,
                                        PendingMeta::Chat {
                                            retries: retries + 1,
                                            target_peer: next_peer,
                                        },
                                    ),
                                );
                                if let ChatState::Generating { ref mut target_peer, .. } = chat_state {
                                    *target_peer = next_peer;
                                }
                            } else {
                                eprintln!("[!] Aucun worker de repli disponible.");
                                if let ChatState::Generating { response_tx, .. } = std::mem::replace(&mut chat_state, ChatState::Idle) {
                                    if let Some(tx) = response_tx {
                                        let _ = tx.send(serde_json::json!({
                                            "ok": false,
                                            "error": format!("Aucun worker P2P actif disponible après échec vers {}", peer),
                                            "failed_worker_peer_id": peer.to_string(),
                                        }));
                                    }
                                }
                                chat_state = ChatState::Idle;
                                print!("> Vous : ");
                                tokio::io::stdout().flush().await?;
                            }
                        } else {
                            eprintln!("[!] Max retries atteint. Chat interrompu.");
                            if let ChatState::Generating { response_tx, target_peer, .. } = std::mem::replace(&mut chat_state, ChatState::Idle) {
                                if let Some(tx) = response_tx {
                                    let _ = tx.send(serde_json::json!({
                                        "ok": false,
                                        "error": format!("Impossible de joindre le worker P2P {}", target_peer),
                                        "failed_worker_peer_id": target_peer.to_string(),
                                    }));
                                }
                            }
                            chat_state = ChatState::Idle;
                            print!("> Vous : ");
                            tokio::io::stdout().flush().await?;
                        }
                    }
                }

                _ => {}
            }
        }
    }
}
