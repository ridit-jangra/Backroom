//! PKCE verifier store for the desktop login hand-off (RFC 7636, S256).
//!
//! `login_challenge` returns the challenge of the pending 32-byte verifier,
//! making a fresh one only when none is pending or it expired. The verifier is
//! kept in memory only (one at a time, valid for 20 minutes from creation).
//! `take_verifier` hands the verifier out at most once. Neither the verifier
//! nor the challenge is ever logged.

use std::sync::{Mutex, MutexGuard, PoisonError};
use std::time::{Duration, Instant};

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use sha2::{Digest, Sha256};

/// How long a verifier stays usable after `login_challenge`.
pub const VERIFIER_TTL: Duration = Duration::from_secs(20 * 60);

/// Managed state: the single pending verifier and when it was made.
#[derive(Default)]
pub struct VerifierStore(Mutex<Option<(String, Instant)>>);

impl VerifierStore {
    /// S256 challenge of the pending verifier while it is still valid, else of a
    /// fresh one. Reusing it lets every outstanding login email sign in (P5-R11);
    /// the TTL still counts from when the verifier was made.
    pub fn login_challenge(&self) -> String {
        self.login_challenge_at(Instant::now())
    }

    /// The pending verifier, at most once and only within [`VERIFIER_TTL`].
    pub fn take_verifier(&self) -> Option<String> {
        self.take_verifier_at(Instant::now())
    }

    /// [`Self::login_challenge`] with an injected clock.
    pub fn login_challenge_at(&self, now: Instant) -> String {
        let mut slot = self.slot();
        if let Some((verifier, created)) = slot.as_ref() {
            if is_live(*created, now) {
                return challenge_for(verifier);
            }
        }
        let verifier = new_verifier();
        let challenge = challenge_for(&verifier);
        *slot = Some((verifier, now));
        challenge
    }

    /// [`Self::take_verifier`] with an injected clock.
    pub fn take_verifier_at(&self, now: Instant) -> Option<String> {
        // Always cleared: a verifier is used once, and an expired one is dropped.
        let (verifier, created) = self.slot().take()?;
        is_live(created, now).then_some(verifier)
    }

    fn slot(&self) -> MutexGuard<'_, Option<(String, Instant)>> {
        self.0.lock().unwrap_or_else(PoisonError::into_inner)
    }
}

/// True while a verifier made at `created` is still usable at `now`.
fn is_live(created: Instant, now: Instant) -> bool {
    now.saturating_duration_since(created) < VERIFIER_TTL
}

/// base64url(SHA-256(verifier)) without padding.
pub fn challenge_for(verifier: &str) -> String {
    URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()))
}

/// 32 bytes from the thread-local CSPRNG (OS-seeded ChaCha), base64url, no padding.
fn new_verifier() -> String {
    let mut bytes = [0u8; 32];
    rand::fill(&mut bytes);
    URL_SAFE_NO_PAD.encode(bytes)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn is_b64url(s: &str) -> bool {
        s.bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
    }

    #[test]
    fn challenge_matches_rfc7636_vector() {
        // RFC 7636 Appendix B.
        assert_eq!(
            challenge_for("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"),
            "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"
        );
    }

    #[test]
    fn login_challenge_is_s256_of_the_stored_verifier() {
        let store = VerifierStore::default();
        let now = Instant::now();
        let challenge = store.login_challenge_at(now);
        assert_eq!(challenge.len(), 43);
        assert!(is_b64url(&challenge));
        let verifier = store.take_verifier_at(now).expect("verifier");
        assert_eq!(verifier.len(), 43, "32 random bytes, base64url, no padding");
        assert!(is_b64url(&verifier));
        assert_eq!(challenge_for(&verifier), challenge);
    }

    #[test]
    fn take_verifier_returns_some_once_then_none() {
        let store = VerifierStore::default();
        let now = Instant::now();
        assert_eq!(store.take_verifier_at(now), None, "nothing pending yet");
        store.login_challenge_at(now);
        assert!(store.take_verifier_at(now).is_some());
        assert_eq!(store.take_verifier_at(now), None);
    }

    #[test]
    fn verifier_expires_after_20_minutes() {
        let store = VerifierStore::default();
        let t0 = Instant::now();
        store.login_challenge_at(t0);
        assert!(store
            .take_verifier_at(t0 + VERIFIER_TTL - Duration::from_secs(1))
            .is_some());

        store.login_challenge_at(t0);
        assert_eq!(store.take_verifier_at(t0 + VERIFIER_TTL), None);
        // An expired verifier is gone, not kept for later.
        assert_eq!(store.take_verifier_at(t0), None);
    }

    #[test]
    fn repeated_challenge_reuses_the_pending_verifier() {
        // Every outstanding email shares one verifier, so any of them can sign in.
        let store = VerifierStore::default();
        let t0 = Instant::now();
        let first = store.login_challenge_at(t0);
        let second = store.login_challenge_at(t0 + Duration::from_secs(60));
        assert_eq!(first, second, "pending verifier reused, not replaced");
        let verifier = store
            .take_verifier_at(t0 + Duration::from_secs(61))
            .unwrap();
        assert_eq!(challenge_for(&verifier), first);
        assert_eq!(store.take_verifier_at(t0), None, "still single-use");
    }

    #[test]
    fn reuse_does_not_extend_the_verifier_lifetime() {
        let store = VerifierStore::default();
        let t0 = Instant::now();
        store.login_challenge_at(t0);
        store.login_challenge_at(t0 + VERIFIER_TTL - Duration::from_secs(1));
        assert!(
            store.take_verifier_at(t0 + VERIFIER_TTL).is_none(),
            "TTL counts from the first challenge"
        );
    }

    #[test]
    fn expired_or_used_verifier_is_replaced_by_a_fresh_one() {
        let store = VerifierStore::default();
        let t0 = Instant::now();
        let first = store.login_challenge_at(t0);
        let after_expiry = store.login_challenge_at(t0 + VERIFIER_TTL);
        assert_ne!(first, after_expiry, "expired verifier is not reused");
        let verifier = store.take_verifier_at(t0 + VERIFIER_TTL).unwrap();
        assert_eq!(challenge_for(&verifier), after_expiry);

        let after_use = store.login_challenge_at(t0 + VERIFIER_TTL);
        assert_ne!(after_use, after_expiry, "a used verifier is never reissued");
    }
}
