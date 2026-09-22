use std::io::Read;
use std::num::NonZeroU16;
use std::process::Command;
use std::sync::Arc;
use std::time::Duration;

use base64::Engine;
use serde::{de::DeserializeOwned, Deserialize};

struct LcuCreds {
    port: NonZeroU16,
    password: String,
}

const REQUEST_TIMEOUT: Duration = Duration::from_secs(2);
const MAX_RESPONSE_BYTES: u64 = 1_048_576;

fn parse_port(value: &str) -> Option<NonZeroU16> {
    if value.is_empty() || !value.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    value.parse::<u16>().ok().and_then(NonZeroU16::new)
}

fn extract_arg<'a>(line: &'a str, key: &str) -> Option<&'a str> {
    line.split_whitespace()
        .find_map(|token| token.strip_prefix(key))
}

/// Each candidate must provide a complete, valid pair on the same process line.
fn parse_creds(stdout: &str) -> Result<Option<LcuCreds>, String> {
    let mut saw_client = false;
    for line in stdout.lines() {
        // The executable path may contain spaces; match its final component,
        // not helper names such as LeagueClientUx Helper.
        let executable = line.split(" --").next().unwrap_or("").trim();
        if executable.rsplit('/').next() != Some("LeagueClientUx") {
            continue;
        }
        saw_client = true;
        let port = extract_arg(line, "--app-port=").and_then(parse_port);
        let password = extract_arg(line, "--remoting-auth-token=").filter(|s| !s.is_empty());
        if let (Some(port), Some(password)) = (port, password) {
            return Ok(Some(LcuCreds {
                port,
                password: password.to_owned(),
            }));
        }
    }
    if saw_client {
        Err("Unable to read LCU connection details".to_owned())
    } else {
        Ok(None)
    }
}

/// Discover once per invocation; never cache credentials across client restarts.
fn discover_creds() -> Result<Option<LcuCreds>, String> {
    let output = Command::new("/bin/ps")
        .args(["-ww", "-A", "-o", "command="])
        .output()
        .map_err(|_| "Unable to discover League client".to_owned())?;
    if !output.status.success() {
        return Err("Unable to discover League client".to_owned());
    }
    let stdout = std::str::from_utf8(&output.stdout)
        .map_err(|_| "Unable to read League client process information".to_owned())?;
    parse_creds(stdout)
}

fn lcu_agent() -> Result<ureq::Agent, String> {
    // Only this loopback-only agent accepts the client's self-signed certificate.
    let connector = native_tls::TlsConnector::builder()
        .danger_accept_invalid_certs(true)
        .danger_accept_invalid_hostnames(true)
        .build()
        .map_err(|_| "Unable to initialize LCU TLS".to_owned())?;
    Ok(ureq::AgentBuilder::new()
        .redirects(0)
        .try_proxy_from_env(false)
        .timeout(REQUEST_TIMEOUT)
        .timeout_connect(REQUEST_TIMEOUT)
        .timeout_read(REQUEST_TIMEOUT)
        .timeout_write(REQUEST_TIMEOUT)
        .tls_connector(Arc::new(connector))
        .build())
}

fn lcu_get(agent: &ureq::Agent, creds: &LcuCreds, path: &str) -> Result<Option<String>, String> {
    let url = format!("https://127.0.0.1:{}{path}", creds.port);
    let authorization = format!(
        "Basic {}",
        base64::engine::general_purpose::STANDARD.encode(format!("riot:{}", creds.password))
    );
    let response = match agent.get(&url).set("Authorization", &authorization).call() {
        Ok(response) => response,
        Err(ureq::Error::Status(404, _)) => return Ok(None),
        Err(ureq::Error::Status(code, _)) => return Err(format!("LCU returned HTTP {code}")),
        // Never expose transport details, URLs, response bodies, or credentials.
        Err(ureq::Error::Transport(_)) => return Err("LCU request failed".to_owned()),
    };
    // With redirects disabled, ureq returns 3xx responses without following them.
    if !(200..300).contains(&response.status()) {
        return Err(format!("LCU returned HTTP {}", response.status()));
    }
    let mut body = String::new();
    response
        .into_reader()
        .take(MAX_RESPONSE_BYTES + 1)
        .read_to_string(&mut body)
        .map_err(|_| "Unable to read LCU response".to_owned())?;
    if body.len() as u64 > MAX_RESPONSE_BYTES {
        return Err("LCU response is too large".to_owned());
    }
    Ok(Some(body))
}

fn parse_json<T: DeserializeOwned>(body: &str) -> Result<T, String> {
    serde_json::from_str(body).map_err(|_| "Invalid LCU response".to_owned())
}

#[derive(Deserialize)]
struct ChampSelectSession {
    #[serde(rename = "localPlayerCellId")]
    local_player_cell_id: i64,
    #[serde(rename = "myTeam", default)]
    my_team: Vec<ChampSelectPlayer>,
}

#[derive(Deserialize)]
struct ChampSelectPlayer {
    #[serde(rename = "cellId")]
    cell_id: i64,
    #[serde(rename = "championId", default)]
    champion_id: i64,
}

fn session_champion(body: &str) -> Result<Option<i64>, String> {
    let session: ChampSelectSession = parse_json(body)?;
    Ok(session
        .my_team
        .iter()
        .find(|player| player.cell_id == session.local_player_cell_id)
        .map(|player| player.champion_id)
        .filter(|id| *id > 0))
}

fn champion_from_requests(
    mut get: impl FnMut(&str) -> Result<Option<String>, String>,
) -> Result<Option<i64>, String> {
    let Some(phase) = get("/lol-gameflow/v1/gameflow-phase")? else {
        return Ok(None);
    };
    if parse_json::<String>(&phase)? != "ChampSelect" {
        return Ok(None);
    }
    let Some(session) = get("/lol-champ-select/v1/session")? else {
        return Ok(None);
    };
    session_champion(&session)
}

fn get_champ_select_champion_blocking() -> Result<Option<i64>, String> {
    let Some(creds) = discover_creds()? else {
        return Ok(None);
    };
    let agent = lcu_agent()?;
    champion_from_requests(|path| lcu_get(&agent, &creds, path))
}

/// Returns the local player's currently selected champion, not a lock-in guarantee.
/// Missing client/session, other phases, or no selected champion return None.
#[tauri::command]
pub async fn get_champ_select_champion() -> Result<Option<i64>, String> {
    tauri::async_runtime::spawn_blocking(get_champ_select_champion_blocking)
        .await
        .map_err(|_| "LCU lookup could not complete".to_owned())?
}

#[cfg(test)]
mod tests {
    use super::*;

    const SESSION: &str = r#"{
        "localPlayerCellId": 3,
        "myTeam": [
            {"cellId": 1, "championId": 22},
            {"cellId": 3, "championId": 103, "championPickIntent": 99}
        ],
        "theirTeam": [{"cellId": 3, "championId": 55}]
    }"#;

    #[test]
    fn camel_case_selects_local_player_on_my_team_not_intent() {
        assert_eq!(session_champion(SESSION), Ok(Some(103)));
    }

    #[test]
    fn missing_local_player_returns_none() {
        let fixture = r#"{"localPlayerCellId":7,"myTeam":[{"cellId":1,"championId":22}]}"#;
        assert_eq!(session_champion(fixture), Ok(None));
        assert_eq!(session_champion(r#"{"localPlayerCellId":7}"#), Ok(None));
    }

    #[test]
    fn zero_or_missing_champion_does_not_use_pick_intent() {
        for player in [
            r#"{"cellId":3,"championId":0,"championPickIntent":99}"#,
            r#"{"cellId":3,"championPickIntent":99}"#,
        ] {
            let fixture = format!(r#"{{"localPlayerCellId":3,"myTeam":[{player}]}}"#);
            assert_eq!(session_champion(&fixture), Ok(None));
        }
    }

    #[test]
    fn malformed_json_and_schema_return_sanitized_errors() {
        for fixture in [
            "secret-invalid-json",
            "null",
            r#"{"localPlayerCellId":"secret"}"#,
        ] {
            assert_eq!(
                session_champion(fixture),
                Err("Invalid LCU response".to_owned())
            );
        }
    }

    #[test]
    fn ports_must_be_nonzero_u16_decimal() {
        for value in ["", "0", "65536", "-1", "+80", "80x", " 80", "80/path"] {
            assert!(parse_port(value).is_none(), "accepted {value}");
        }
        for (value, expected) in [("1", 1), ("54321", 54321), ("65535", 65535)] {
            assert_eq!(parse_port(value).map(NonZeroU16::get), Some(expected));
        }
    }

    #[test]
    fn credentials_are_never_mixed_across_lines() {
        let fixture =
            "LeagueClientUx --app-port=1234\nLeagueClientUx --remoting-auth-token=fixture-token";
        assert!(parse_creds(fixture).is_err());
        let complete = format!(
            "{fixture}\nLeagueClientUx --app-port=5678 --remoting-auth-token=complete-token"
        );
        let creds = parse_creds(&complete).unwrap().unwrap();
        assert_eq!(creds.port.get(), 5678);
        assert_eq!(creds.password, "complete-token");
    }

    #[test]
    fn invalid_credentials_return_sanitized_errors() {
        for args in [
            "--app-port=0 --remoting-auth-token=secret",
            "--app-port=65536 --remoting-auth-token=secret",
            "--app-port=1234 --remoting-auth-token=",
        ] {
            let result = parse_creds(&format!("LeagueClientUx {args}"));
            assert_eq!(
                result.err().as_deref(),
                Some("Unable to read LCU connection details")
            );
        }
    }

    #[test]
    fn absent_client_and_helpers_return_none() {
        for fixture in [
            "",
            "/bin/other --app-port=1234 --remoting-auth-token=fixture",
            "LeagueClientUx Helper --app-port=1234 --remoting-auth-token=fixture",
        ] {
            assert!(parse_creds(fixture).unwrap().is_none());
        }
    }

    #[test]
    fn executable_path_with_spaces_and_argument_order_are_supported() {
        let fixture = "/Applications/League of Legends.app/Contents/MacOS/LeagueClientUx --remoting-auth-token=fixture --app-port=1234";
        let creds = parse_creds(fixture).unwrap().unwrap();
        assert_eq!(creds.port.get(), 1234);
        assert_eq!(creds.password, "fixture");
    }

    #[test]
    fn other_phase_or_missing_phase_stops_before_session_request() {
        for response in [None, Some(r#""Lobby""#.to_owned())] {
            let mut calls = 0;
            let result = champion_from_requests(|path| {
                calls += 1;
                assert_eq!(path, "/lol-gameflow/v1/gameflow-phase");
                Ok(response.clone())
            });
            assert_eq!(result, Ok(None));
            assert_eq!(calls, 1);
        }
    }

    #[test]
    fn champ_select_session_or_404_is_handled() {
        for (session, expected) in [(None, None), (Some(SESSION.to_owned()), Some(103))] {
            let mut paths = Vec::new();
            let result = champion_from_requests(|path| {
                paths.push(path.to_owned());
                if paths.len() == 1 {
                    Ok(Some(r#""ChampSelect""#.to_owned()))
                } else {
                    Ok(session.clone())
                }
            });
            assert_eq!(result, Ok(expected));
            assert_eq!(
                paths,
                [
                    "/lol-gameflow/v1/gameflow-phase",
                    "/lol-champ-select/v1/session"
                ]
            );
        }
    }

    #[test]
    fn phase_parse_and_request_errors_propagate() {
        assert_eq!(
            champion_from_requests(|_| Ok(Some("{}".to_owned()))),
            Err("Invalid LCU response".to_owned())
        );
        assert_eq!(
            champion_from_requests(|_| Err("LCU request failed".to_owned())),
            Err("LCU request failed".to_owned())
        );
    }
}
