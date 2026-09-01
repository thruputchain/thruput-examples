use std::collections::HashSet;
use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::Arc;

use sha2::{Digest, Sha256};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::{RwLock, Semaphore};

use crate::storage::resolve_request;
use crate::{LifeStatus, MAX_ZOOM};

#[derive(Debug, thiserror::Error)]
pub enum WebError {
    #[error("HTTP listener must be loopback, got {0}")]
    NonLoopback(SocketAddr),
    #[error("HTTP I/O failed: {0}")]
    Io(#[from] std::io::Error),
}

pub struct HttpService {
    root: PathBuf,
    status: Arc<RwLock<LifeStatus>>,
    network_id: String,
    contract_address: String,
    origins: HashSet<String>,
    connections: Arc<Semaphore>,
    read_timeout: std::time::Duration,
}

const MAX_HEADER_BYTES: usize = 16 * 1024;

impl HttpService {
    pub fn new(
        root: PathBuf,
        status: Arc<RwLock<LifeStatus>>,
        network_id: String,
        contract_address: String,
        origins: impl IntoIterator<Item = String>,
    ) -> Self {
        Self {
            root,
            status,
            network_id,
            contract_address,
            origins: origins.into_iter().collect(),
            connections: Arc::new(Semaphore::new(64)),
            read_timeout: std::time::Duration::from_secs(5),
        }
    }

    pub async fn serve(self: Arc<Self>, address: SocketAddr) -> Result<(), WebError> {
        if !address.ip().is_loopback() {
            return Err(WebError::NonLoopback(address));
        }
        let listener = TcpListener::bind(address).await?;
        loop {
            let permit = Arc::clone(&self.connections)
                .acquire_owned()
                .await
                .map_err(|_| std::io::Error::other("HTTP connection limiter closed"))?;
            let (stream, peer) = listener.accept().await?;
            if !peer.ip().is_loopback() {
                continue;
            }
            let service = Arc::clone(&self);
            tokio::spawn(async move {
                let _permit = permit;
                let _ = service.respond(stream).await;
            });
        }
    }

    #[doc(hidden)]
    pub fn with_read_timeout_for_test(mut self, timeout: std::time::Duration) -> Self {
        self.read_timeout = timeout;
        self
    }

    #[doc(hidden)]
    pub async fn serve_connection_for_test(&self, stream: TcpStream) -> Result<(), std::io::Error> {
        self.respond(stream).await
    }

    async fn respond(&self, mut stream: TcpStream) -> Result<(), std::io::Error> {
        let response = match self.read_headers(&mut stream).await {
            Ok(request) => self.handle(&request).await,
            Err(ReadRequestError::Timeout) => self.response(
                408,
                "text/plain",
                "no-store",
                None,
                None,
                b"request timeout",
            ),
            Err(ReadRequestError::TooLarge) => self.response(
                431,
                "text/plain",
                "no-store",
                None,
                None,
                b"request headers too large",
            ),
            Err(ReadRequestError::Truncated) => self.response(
                400,
                "text/plain",
                "no-store",
                None,
                None,
                b"truncated request",
            ),
            Err(ReadRequestError::Io(error)) => return Err(error),
        };
        stream.write_all(&response).await
    }

    async fn read_headers(&self, stream: &mut TcpStream) -> Result<Vec<u8>, ReadRequestError> {
        let read = async {
            let mut request = Vec::with_capacity(1024);
            let mut chunk = [0u8; 2048];
            loop {
                let length = stream
                    .read(&mut chunk)
                    .await
                    .map_err(ReadRequestError::Io)?;
                if length == 0 {
                    return Err(ReadRequestError::Truncated);
                }
                request.extend_from_slice(&chunk[..length]);
                if let Some(end) = header_end(&request) {
                    if end > MAX_HEADER_BYTES {
                        return Err(ReadRequestError::TooLarge);
                    }
                    request.truncate(end);
                    return Ok(request);
                }
                if request.len() >= MAX_HEADER_BYTES {
                    return Err(ReadRequestError::TooLarge);
                }
            }
        };
        tokio::time::timeout(self.read_timeout, read)
            .await
            .map_err(|_| ReadRequestError::Timeout)?
    }

    pub async fn handle(&self, request: &[u8]) -> Vec<u8> {
        let Some(end) = header_end(request) else {
            return self.response(400, "text/plain", "no-store", None, None, b"bad request");
        };
        if end > MAX_HEADER_BYTES {
            return self.response(
                431,
                "text/plain",
                "no-store",
                None,
                None,
                b"request headers too large",
            );
        }
        let Ok(text) = std::str::from_utf8(&request[..end]) else {
            return self.response(400, "text/plain", "no-store", None, None, b"bad request");
        };
        let mut lines = text.split("\r\n");
        let Some(first) = lines.next() else {
            return self.response(400, "text/plain", "no-store", None, None, b"bad request");
        };
        let parts: Vec<_> = first.split(' ').collect();
        if parts.len() != 3 || parts[0] != "GET" || parts[2] != "HTTP/1.1" {
            return self.response(
                405,
                "text/plain",
                "no-store",
                None,
                None,
                b"method not allowed",
            );
        }
        let path = parts[1];
        if path.contains('?') || !self.valid_route(path) {
            return self.response(404, "text/plain", "no-store", None, None, b"not found");
        }
        let mut origin = None;
        let mut if_none_match = String::new();
        for line in lines {
            if let Some((name, value)) = line.split_once(':') {
                let value = value.trim();
                if name.eq_ignore_ascii_case("origin") {
                    if origin.is_some() {
                        return self.response(
                            400,
                            "text/plain",
                            "no-store",
                            None,
                            None,
                            b"duplicate origin",
                        );
                    }
                    origin = Some(value);
                } else if name.eq_ignore_ascii_case("if-none-match") {
                    if !if_none_match.is_empty() {
                        if_none_match.push(',');
                    }
                    if_none_match.push_str(value);
                }
            }
        }
        let allow_origin = match origin {
            Some(value) if self.origins.contains(value) => Some(value),
            Some(_) => {
                return self.response(403, "text/plain", "no-store", None, None, b"origin denied");
            }
            None => None,
        };
        let (body, content_type, cache) = if path.ends_with("/status.json") {
            let status = self.status.read().await.clone();
            (
                serde_json::to_vec(&status).unwrap_or_default(),
                "application/json",
                "no-cache",
            )
        } else {
            let Ok(file) = resolve_request(&self.root, path) else {
                return self.response(
                    404,
                    "text/plain",
                    "no-store",
                    None,
                    allow_origin,
                    b"not found",
                );
            };
            let Ok(bytes) = tokio::fs::read(file).await else {
                return self.response(
                    404,
                    "text/plain",
                    "no-store",
                    None,
                    allow_origin,
                    b"not found",
                );
            };
            let immutable = path.contains("/0x") && !path.ends_with("/latest.json");
            let content_type = if path.ends_with(".json") {
                "application/json"
            } else if path.contains("/tiles/6/") {
                "application/vnd.groundhog.life-cells-v1"
            } else {
                "application/vnd.groundhog.life-density-u16le"
            };
            (
                bytes,
                content_type,
                if immutable {
                    "public, max-age=31536000, immutable"
                } else {
                    "no-cache"
                },
            )
        };
        let etag = format!("\"{}\"", hex::encode(Sha256::digest(&body)));
        if etag_matches(&if_none_match, &etag) {
            return self.response(304, content_type, cache, Some(&etag), allow_origin, b"");
        }
        self.response(200, content_type, cache, Some(&etag), allow_origin, &body)
    }

    fn valid_route(&self, path: &str) -> bool {
        valid_route(path, &self.network_id, &self.contract_address)
    }

    fn response(
        &self,
        status: u16,
        content_type: &str,
        cache: &str,
        etag: Option<&str>,
        origin: Option<&str>,
        body: &[u8],
    ) -> Vec<u8> {
        response(
            status,
            content_type,
            cache,
            etag,
            origin,
            !self.origins.is_empty(),
            body,
        )
    }
}

enum ReadRequestError {
    Timeout,
    TooLarge,
    Truncated,
    Io(std::io::Error),
}

pub async fn heartbeat(status: Arc<RwLock<LifeStatus>>) {
    heartbeat_with_interval(status, std::time::Duration::from_secs(4)).await;
}

#[doc(hidden)]
pub async fn heartbeat_with_interval(status: Arc<RwLock<LifeStatus>>, period: std::time::Duration) {
    let mut interval = tokio::time::interval(period);
    loop {
        interval.tick().await;
        status.write().await.heartbeat_at = now();
    }
}

fn valid_route(path: &str, network_id: &str, contract_address: &str) -> bool {
    if path.contains('%')
        || path.contains("..")
        || path.contains('\\')
        || !path.starts_with("/v1/worlds/")
    {
        return false;
    }
    let parts: Vec<_> = path.split('/').skip(1).collect();
    if parts.len() < 5
        || parts[0] != "v1"
        || parts[1] != "worlds"
        || !network(parts[2])
        || !hex32(parts[3])
        || parts[2] != network_id
        || parts[3] != contract_address
    {
        return false;
    }
    match parts.as_slice() {
        ["v1", "worlds", _, _, "latest.json" | "status.json"] => true,
        [
            "v1",
            "worlds",
            _,
            _,
            digest,
            "manifest.json" | "provenance.json",
        ] => hex32(digest),
        ["v1", "worlds", _, _, digest, "tiles", z, x, file] if hex32(digest) => {
            let Ok(z) = z.parse::<u8>() else {
                return false;
            };
            let Ok(x) = x.parse::<u32>() else {
                return false;
            };
            let Some(y) = file
                .strip_suffix(".bin")
                .and_then(|value| value.parse::<u32>().ok())
            else {
                return false;
            };
            if z > MAX_ZOOM {
                return false;
            }
            let count = 10_000u32.div_ceil(256 * (1u32 << (MAX_ZOOM - z)));
            x < count && y < count
        }
        _ => false,
    }
}

fn response(
    status: u16,
    content_type: &str,
    cache: &str,
    etag: Option<&str>,
    origin: Option<&str>,
    vary_origin: bool,
    body: &[u8],
) -> Vec<u8> {
    let reason = match status {
        200 => "OK",
        304 => "Not Modified",
        400 => "Bad Request",
        403 => "Forbidden",
        404 => "Not Found",
        405 => "Method Not Allowed",
        408 => "Request Timeout",
        431 => "Request Header Fields Too Large",
        _ => "Error",
    };
    let mut headers = format!(
        "HTTP/1.1 {status} {reason}\r\nContent-Type: {content_type}\r\nCache-Control: {cache}\r\nContent-Length: {}\r\nX-Content-Type-Options: nosniff\r\n",
        body.len()
    );
    if let Some(value) = etag {
        headers.push_str(&format!("ETag: {value}\r\n"));
    }
    if let Some(value) = origin {
        headers.push_str(&format!("Access-Control-Allow-Origin: {value}\r\n"));
    }
    if vary_origin {
        headers.push_str("Vary: Origin\r\n");
    }
    headers.push_str("Connection: close\r\n\r\n");
    let mut output = headers.into_bytes();
    output.extend_from_slice(body);
    output
}

fn header_end(request: &[u8]) -> Option<usize> {
    request
        .windows(4)
        .position(|window| window == b"\r\n\r\n")
        .map(|position| position + 4)
}

fn etag_matches(header: &str, current: &str) -> bool {
    !header.is_empty()
        && header.split(',').any(|candidate| {
            let candidate = candidate.trim();
            candidate == "*" || candidate.strip_prefix("W/").unwrap_or(candidate) == current
        })
}

fn now() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}
fn network(value: &str) -> bool {
    value.len() == 64 && value.bytes().all(lower_hex)
}
fn hex32(value: &str) -> bool {
    value.len() == 66 && value.starts_with("0x") && value[2..].bytes().all(lower_hex)
}
fn lower_hex(value: u8) -> bool {
    value.is_ascii_digit() || (b'a'..=b'f').contains(&value)
}
