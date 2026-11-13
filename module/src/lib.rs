//! /indulgence — SpacetimeDB module.
//!
//! Authoritative state for the endless cathedral: accounts, follow edges, sessions,
//! priests, prayers and candles. Only the gate service may call reducers; browsers hold
//! read-only viewer tokens and subscribe to public tables plus two per-viewer views.
//!
//! Row-level security (`client_visibility_filter`) is not enforced in SpacetimeDB 2.14
//! (it is gated behind `unstable` and documented as unimplemented), so the per-viewer
//! data lives in private tables and is exposed through the `viewer_label` and
//! `prayer_text` views, which filter on `ctx.sender()`.

#![allow(non_snake_case)] // env var accessors are SCREAMING_CASE

use spacetimedb::{
    Identity, ReducerContext, ScheduleAt, SpacetimeType, Table, TimeDuration, Timestamp, ViewContext,
    rand::Rng,
};
use std::collections::HashSet;

pub mod constants {
    /// One row of the spend-tier table in `shared/constants.json`.
    #[derive(Clone, Copy, Debug)]
    pub struct SpendTier {
        pub min: u64,
        pub vestment: &'static str,
        pub candle: &'static str,
        pub burn_h: u64,
    }
    include!(concat!(env!("OUT_DIR"), "/constants.rs"));
}
pub mod geometry;

use constants as c;
use geometry::SeatAddr;

/// The JWT subject the gate uses for its own SpacetimeDB connection.
pub const GATE_SUBJECT: &str = "gate";

// ---------------------------------------------------------------------------
// Publish-time configuration
// ---------------------------------------------------------------------------

/// Set at publish time (`spacetime publish` reads these from the shell or spacetime.json).
#[spacetimedb::env]
pub struct Env {
    /// The gate's issuer URL, exactly as it appears in the `iss` claim.
    pub INDULGENCE_ISSUER: String,
    /// The audience the gate puts in every JWT it signs for this database.
    pub INDULGENCE_AUDIENCE: String,
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

#[derive(SpacetimeType, Clone, Copy, Debug, PartialEq, Eq)]
pub enum LabelMode {
    Username,
    FullName,
}

#[derive(SpacetimeType, Clone, Copy, Debug, PartialEq, Eq)]
pub enum Tier {
    /// `pray` mode chosen at `begin`; no prayer has reported a tier yet.
    Pending,
    Sampling,
    Subagent,
    InSession,
}

#[derive(SpacetimeType, Clone, Copy, Debug, PartialEq, Eq)]
pub enum Vestment {
    Friar,
    Priest,
    Bishop,
    Cardinal,
}

#[derive(SpacetimeType, Clone, Copy, Debug, PartialEq, Eq)]
pub enum CandleSize {
    Taper,
    Votive,
    Pillar,
    Paschal,
}

#[derive(SpacetimeType, Clone, Copy, Debug, PartialEq, Eq)]
pub enum PriestState {
    Entering,
    Praying,
    Departing,
}

fn vestment_for(tier: usize) -> Vestment {
    [Vestment::Friar, Vestment::Priest, Vestment::Bishop, Vestment::Cardinal][tier.min(3)]
}

fn candle_for(tier: usize) -> CandleSize {
    [CandleSize::Taper, CandleSize::Votive, CandleSize::Pillar, CandleSize::Paschal][tier.min(3)]
}

// ---------------------------------------------------------------------------
// Private tables
// ---------------------------------------------------------------------------

/// The identity that published the module (`init` sender). May use the CLI for SQL.
#[spacetimedb::table(accessor = owner)]
pub struct Owner {
    #[primary_key]
    pub id: u8,
    pub identity: Identity,
}

/// Identities allowed to call reducers. Registered when the gate connects with a JWT
/// from the configured issuer carrying `role: "gate"` and `sub: "gate"`.
#[spacetimedb::table(accessor = gate_service)]
pub struct GateService {
    #[primary_key]
    pub identity: Identity,
    pub since: Timestamp,
}

/// One row per GitHub user.
#[spacetimedb::table(accessor = account)]
pub struct Account {
    /// The user's viewer identity: `Identity::from_claims(issuer, viewer_sub)`.
    #[primary_key]
    pub identity: Identity,
    /// HMAC of the GitHub numeric id.
    #[unique]
    pub gh_hash: String,
    pub gh_login: String,
    /// Display name, already cleaned and capped by the gate. Empty if unusable.
    pub gh_name: String,
    pub label_mode: LabelMode,
    pub consent_at: Timestamp,
    pub updated_at: Timestamp,
}

/// OAuth grants revoked at the gate's `/revoke` endpoint. A grant is one account signed in
/// through one OAuth client, identified by an HMAC the gate computes. Refresh tokens of the
/// grant issued at or before `revoked_at` are refused; rows are dropped once every such
/// token has expired.
#[spacetimedb::table(accessor = revoked_grant)]
pub struct RevokedGrant {
    #[primary_key]
    pub grant: String,
    #[index(btree)]
    pub gh_hash: String,
    pub revoked_at: Timestamp,
}

/// Mutual follows asserted by the owner's latest sign-in, stored as HMAC hashes.
#[spacetimedb::table(accessor = follow_edge)]
pub struct FollowEdge {
    #[primary_key]
    #[auto_inc]
    pub id: u64,
    #[index(btree)]
    pub owner_hash: String,
    #[index(btree)]
    pub other_hash: String,
}

/// Sessions: live ones plus ended ones kept for 7 days (spend percentiles, retention).
#[spacetimedb::table(accessor = session)]
pub struct Session {
    #[primary_key]
    pub session_id: String,
    #[index(btree)]
    pub identity: Identity,
    #[unique]
    pub priest_id: u64,
    pub tier: Tier,
    /// Whether this session's prayers may be read by the owner's live mutuals (the default).
    /// When the user opted out, everyone but the owner sees only canned prayers.
    pub share: bool,
    pub budget: u64,
    pub spent: u64,
    pub prayers: u32,
    #[index(btree)]
    pub started_at: Timestamp,
    pub last_seen: Timestamp,
    pub cancel_at: Option<Timestamp>,
    pub ended_at: Option<Timestamp>,
    #[index(btree)]
    pub live: bool,
}

/// Which identity a candle belongs to (kept out of the public `candle` table).
#[spacetimedb::table(accessor = candle_owner)]
pub struct CandleOwner {
    #[primary_key]
    pub candle_id: u64,
    #[index(btree)]
    pub identity: Identity,
}

/// Hover names. Exposed to each viewer through the `viewer_label` view.
#[spacetimedb::table(accessor = viewer_label_store)]
pub struct ViewerLabel {
    #[primary_key]
    #[auto_inc]
    pub id: u64,
    #[index(btree)]
    pub viewer: Identity,
    #[index(btree)]
    pub priest_id: u64,
    pub label: String,
}

/// Real prayer text for the owner and eligible mutuals; last 3 per (viewer, priest).
/// Exposed to each viewer through the `prayer_text` view.
#[spacetimedb::table(
    accessor = prayer_text_store,
    index(accessor = by_pair, btree(columns = [viewer, priest_id]))
)]
pub struct PrayerText {
    #[primary_key]
    #[auto_inc]
    pub id: u64,
    #[index(btree)]
    pub viewer: Identity,
    #[index(btree)]
    pub priest_id: u64,
    pub seq: u32,
    pub text: String,
    pub at: Timestamp,
}

// ---------------------------------------------------------------------------
// Public tables (anonymous scene state)
// ---------------------------------------------------------------------------

#[spacetimedb::table(accessor = priest, public)]
pub struct Priest {
    #[primary_key]
    pub priest_id: u64,
    #[index(btree)]
    pub x: i32,
    pub y: i32,
    #[index(btree)]
    pub bay: i32,
    pub row: u8,
    /// 0 = left of the aisle, 1 = right.
    pub half: u8,
    /// Seat index i within the half-row; 0 is at the aisle end.
    pub seat: u8,
    pub vestment: Vestment,
    pub state: PriestState,
    pub state_since: Timestamp,
    /// When it came in, so viewers who connect mid-walk can finish the walk to its pew.
    pub entered_at: Timestamp,
    /// The candle this priest lights on departure (0 until departing).
    pub candle_id: u64,
}

/// Latest prayer slot per priest. Strangers see canned prayer `canned_idx`.
#[spacetimedb::table(accessor = prayer_tick, public)]
pub struct PrayerTick {
    #[primary_key]
    pub priest_id: u64,
    #[index(btree)]
    pub x: i32,
    pub seq: u32,
    pub canned_idx: u32,
    pub at: Timestamp,
}

#[spacetimedb::table(accessor = candle, public)]
pub struct Candle {
    #[primary_key]
    #[auto_inc]
    pub candle_id: u64,
    #[index(btree)]
    pub x: i32,
    pub y: i32,
    #[index(btree)]
    pub arcade: i32,
    pub slot: u8,
    pub size: CandleSize,
    pub lit_at: Timestamp,
    #[index(btree)]
    pub expires_at: Timestamp,
    /// Public candle name.
    pub label: String,
}

// ---------------------------------------------------------------------------
// Per-viewer views (stand-in for row-level security)
// ---------------------------------------------------------------------------

#[spacetimedb::view(accessor = viewer_label, public)]
fn viewer_label(ctx: &ViewContext) -> Vec<ViewerLabel> {
    ctx.db.viewer_label_store().viewer().filter(ctx.sender()).collect()
}

#[spacetimedb::view(accessor = prayer_text, public)]
fn prayer_text(ctx: &ViewContext) -> Vec<PrayerText> {
    ctx.db.prayer_text_store().viewer().filter(ctx.sender()).collect()
}

// ---------------------------------------------------------------------------
// Scheduled tables
// ---------------------------------------------------------------------------

#[spacetimedb::table(accessor = remove_priest_job, scheduled(remove_priest))]
pub struct RemovePriestJob {
    #[primary_key]
    #[auto_inc]
    pub scheduled_id: u64,
    pub scheduled_at: ScheduleAt,
    pub priest_id: u64,
}

#[spacetimedb::table(accessor = expire_candles_job, scheduled(expire_candles))]
pub struct ExpireCandlesJob {
    #[primary_key]
    #[auto_inc]
    pub scheduled_id: u64,
    pub scheduled_at: ScheduleAt,
}

#[spacetimedb::table(accessor = reap_stale_job, scheduled(reap_stale))]
pub struct ReapStaleJob {
    #[primary_key]
    #[auto_inc]
    pub scheduled_id: u64,
    pub scheduled_at: ScheduleAt,
}

#[spacetimedb::table(accessor = retention_job, scheduled(retention))]
pub struct RetentionJob {
    #[primary_key]
    #[auto_inc]
    pub scheduled_id: u64,
    pub scheduled_at: ScheduleAt,
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/// How long the gate's refresh tokens live (gate/src/oauth/provider.ts REFRESH_TTL_S), plus a day.
const REFRESH_TOKEN_DAYS: i64 = 31;

fn ms(n: i64) -> TimeDuration {
    TimeDuration::from_micros(n * 1000)
}

fn require_gate(ctx: &ReducerContext) -> Result<(), String> {
    if ctx.db.gate_service().identity().find(ctx.sender()).is_some() {
        Ok(())
    } else {
        Err("unauthorized".into())
    }
}

fn require_internal(ctx: &ReducerContext) -> Result<(), String> {
    if ctx.sender_auth().is_internal() {
        Ok(())
    } else {
        Err("unauthorized".into())
    }
}

fn check_len(s: &str, min: usize, max: usize, what: &str) -> Result<(), String> {
    let n = s.chars().count();
    if n < min || n > max {
        return Err(format!("invalid_{what}"));
    }
    Ok(())
}

fn label_of(a: &Account) -> String {
    match a.label_mode {
        LabelMode::FullName if !a.gh_name.is_empty() => a.gh_name.clone(),
        _ => a.gh_login.clone(),
    }
}

/// Live mutuals of `account`, each with their live session.
fn live_mutuals(ctx: &ReducerContext, account: &Account) -> Vec<(Account, Session)> {
    let h = &account.gh_hash;
    let mut hashes: HashSet<String> = ctx
        .db
        .follow_edge()
        .owner_hash()
        .filter(h)
        .map(|e| e.other_hash)
        .collect();
    hashes.extend(ctx.db.follow_edge().other_hash().filter(h).map(|e| e.owner_hash));
    hashes.remove(h);

    let mut out = Vec::new();
    for other in hashes {
        let Some(acct) = ctx.db.account().gh_hash().find(&other) else { continue };
        if let Some(sess) = live_session_of(ctx, acct.identity) {
            out.push((acct, sess));
        }
    }
    out
}

fn live_session_of(ctx: &ReducerContext, identity: Identity) -> Option<Session> {
    ctx.db.session().identity().filter(identity).find(|s| s.live)
}

/// Seats taken in a bay by priests that are not departing.
fn occupied_seats(ctx: &ReducerContext, bay: i32) -> HashSet<SeatAddr> {
    ctx.db
        .priest()
        .bay()
        .filter(bay)
        .filter(|p| p.state != PriestState::Departing)
        .map(|p| SeatAddr { bay: p.bay, row: p.row, half: p.half, i: p.seat })
        .collect()
}

struct CtxRng<'a>(&'a ReducerContext);

impl geometry::Rand for CtxRng<'_> {
    fn below(&mut self, n: usize) -> usize {
        self.0.rng().gen_range(0..n)
    }
}

fn add_prayer_text(ctx: &ReducerContext, viewer: Identity, priest_id: u64, seq: u32, text: &str) {
    ctx.db.prayer_text_store().insert(PrayerText {
        id: 0,
        viewer,
        priest_id,
        seq,
        text: text.to_owned(),
        at: ctx.timestamp,
    });
    let mut rows: Vec<PrayerText> = ctx.db.prayer_text_store().by_pair().filter((viewer, priest_id)).collect();
    if rows.len() > c::PRAYER_TEXT_KEEP_PER_PAIR as usize {
        rows.sort_by_key(|r| r.seq);
        let excess = rows.len() - c::PRAYER_TEXT_KEEP_PER_PAIR as usize;
        for r in rows.into_iter().take(excess) {
            ctx.db.prayer_text_store().id().delete(r.id);
        }
    }
}

fn delete_viewer_rows(ctx: &ReducerContext, identity: Identity, priest_id: u64) {
    ctx.db.viewer_label_store().priest_id().delete(priest_id);
    ctx.db.viewer_label_store().viewer().delete(identity);
    ctx.db.prayer_text_store().priest_id().delete(priest_id);
    ctx.db.prayer_text_store().viewer().delete(identity);
}

/// Place a candle on the priest's own stand, or on the one across its bay if that is full.
/// If both are full it takes the place of the candle that would burn out next, which is
/// removed (see `geometry::place_candle`). Returns the new candle's id.
fn light_candle(ctx: &ReducerContext, session: &Session, priest: &Priest, label: String) -> u64 {
    let primary = geometry::primary_arcade(priest.bay, priest.half);
    let other = geometry::other_arcade(priest.bay, priest.half);
    let burning: Vec<geometry::Burning> = [primary, other]
        .into_iter()
        .flat_map(|arcade| ctx.db.candle().arcade().filter(arcade))
        .map(|c| geometry::Burning {
            candle_id: c.candle_id,
            arcade: c.arcade,
            slot: c.slot,
            lit: c.lit_at <= ctx.timestamp,
            expires_micros: c.expires_at.to_micros_since_unix_epoch(),
        })
        .collect();
    let Some(place) = geometry::place_candle(primary, other, &burning, &mut CtxRng(ctx)) else { return 0 };
    if let Some(old) = place.replaces {
        ctx.db.candle().candle_id().delete(old);
        ctx.db.candle_owner().candle_id().delete(old);
    }
    let (arcade, slot) = (place.arcade, place.slot);
    let tier = geometry::spend_tier(session.spent);
    let lit_at = ctx.timestamp + ms(c::CANDLE_LIT_AFTER_MS);
    let (x, y) = geometry::slot_pos(arcade, slot);
    let candle = ctx.db.candle().insert(Candle {
        candle_id: 0,
        x,
        y,
        arcade,
        slot,
        size: candle_for(tier),
        lit_at,
        expires_at: lit_at + TimeDuration::from_micros(geometry::burn_micros(tier)),
        label,
    });
    ctx.db.candle_owner().insert(CandleOwner { candle_id: candle.candle_id, identity: session.identity });
    candle.candle_id
}

/// End a live session: the priest walks to a stand, lights a candle and leaves.
fn do_depart(ctx: &ReducerContext, mut session: Session, with_candle: bool) {
    if !session.live {
        return;
    }
    session.live = false;
    session.ended_at = Some(ctx.timestamp);
    session.cancel_at = None;
    let identity = session.identity;
    let priest_id = session.priest_id;

    if let Some(mut priest) = ctx.db.priest().priest_id().find(priest_id) {
        let mut candle_id = 0;
        if with_candle {
            if let Some(acct) = ctx.db.account().identity().find(identity) {
                candle_id = light_candle(ctx, &session, &priest, label_of(&acct));
            }
        }
        priest.state = PriestState::Departing;
        priest.state_since = ctx.timestamp;
        priest.candle_id = candle_id;
        ctx.db.priest().priest_id().update(priest);
        ctx.db.remove_priest_job().insert(RemovePriestJob {
            scheduled_id: 0,
            scheduled_at: ScheduleAt::Time(ctx.timestamp + ms(c::PRIEST_REMOVE_AFTER_MS)),
            priest_id,
        });
    }
    ctx.db.session().session_id().update(session);
    delete_viewer_rows(ctx, identity, priest_id);
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

#[spacetimedb::reducer(init)]
pub fn init(ctx: &ReducerContext) {
    ctx.db.owner().insert(Owner { id: 0, identity: ctx.sender() });
    ctx.db.reap_stale_job().insert(ReapStaleJob {
        scheduled_id: 0,
        scheduled_at: ScheduleAt::Interval(ms(c::REAP_EVERY_MS)),
    });
    ctx.db.expire_candles_job().insert(ExpireCandlesJob {
        scheduled_id: 0,
        scheduled_at: ScheduleAt::Interval(ms(c::EXPIRE_CANDLES_EVERY_MS)),
    });
    ctx.db.retention_job().insert(RetentionJob {
        scheduled_id: 0,
        scheduled_at: ScheduleAt::Interval(ms(3_600_000)),
    });
}

/// Only the database owner, the gate and gate-issued viewers may connect.
#[spacetimedb::reducer(client_connected)]
pub fn client_connected(ctx: &ReducerContext) -> Result<(), String> {
    let auth = ctx.sender_auth();
    if auth.is_internal() {
        return Ok(());
    }
    if ctx.db.owner().id().find(0).is_some_and(|o| o.identity == ctx.sender()) {
        return Ok(());
    }
    let jwt = auth.jwt().ok_or("authentication required")?;
    if jwt.issuer() != ctx.env.INDULGENCE_ISSUER() {
        return Err("invalid issuer".into());
    }
    let audience = ctx.env.INDULGENCE_AUDIENCE();
    if !jwt.audience().iter().any(|a| *a == audience) {
        return Err("invalid audience".into());
    }
    let claims: serde_json::Value =
        serde_json::from_str(jwt.raw_payload()).map_err(|_| "invalid token".to_string())?;
    match claims.get("role").and_then(|r| r.as_str()) {
        Some("gate") if jwt.subject() == GATE_SUBJECT => {
            if ctx.db.gate_service().identity().find(ctx.sender()).is_none() {
                ctx.db.gate_service().insert(GateService { identity: ctx.sender(), since: ctx.timestamp });
            }
            Ok(())
        }
        Some("viewer") if jwt.subject() != GATE_SUBJECT => Ok(()),
        _ => Err("invalid role".into()),
    }
}

// ---------------------------------------------------------------------------
// Gate reducers
// ---------------------------------------------------------------------------

/// Write the account row and replace the owner's follow edges.
///
/// `label_mode = None` keeps the stored choice; for a new account it fails with
/// `consent_required`, which is how the gate learns to show the consent screen.
#[spacetimedb::reducer]
pub fn upsert_account(
    ctx: &ReducerContext,
    viewer_sub: String,
    gh_hash: String,
    gh_login: String,
    gh_name: String,
    label_mode: Option<LabelMode>,
    mutual_hashes: Vec<String>,
) -> Result<(), String> {
    require_gate(ctx)?;
    check_len(&viewer_sub, 1, 100, "viewer_sub")?;
    check_len(&gh_hash, 16, 64, "gh_hash")?;
    check_len(&gh_login, 1, 39, "gh_login")?;
    if !gh_login.chars().all(|ch| ch.is_ascii_alphanumeric() || ch == '-') {
        return Err("invalid_gh_login".into());
    }
    check_len(&gh_name, 0, 40, "gh_name")?;
    if mutual_hashes.len() > 10_000 {
        return Err("invalid_mutuals".into());
    }
    for m in &mutual_hashes {
        check_len(m, 16, 64, "mutual")?;
    }

    let identity = Identity::from_claims(&ctx.env.INDULGENCE_ISSUER(), &viewer_sub);
    let existing = ctx.db.account().gh_hash().find(&gh_hash);
    let (mode, consent_at) = match (&existing, label_mode) {
        (_, Some(mode)) => (mode, ctx.timestamp),
        (Some(prev), None) => (prev.label_mode, prev.consent_at),
        (None, None) => return Err("consent_required".into()),
    };
    if let Some(prev) = existing {
        ctx.db.account().identity().delete(prev.identity);
    }
    ctx.db.account().insert(Account {
        identity,
        gh_hash: gh_hash.clone(),
        gh_login,
        gh_name,
        label_mode: mode,
        consent_at,
        updated_at: ctx.timestamp,
    });

    ctx.db.follow_edge().owner_hash().delete(&gh_hash);
    let unique: HashSet<String> = mutual_hashes.into_iter().filter(|m| *m != gh_hash).collect();
    for other in unique {
        ctx.db.follow_edge().insert(FollowEdge { id: 0, owner_hash: gh_hash.clone(), other_hash: other });
    }
    Ok(())
}

/// Checked on every token refresh. Fails with `no_account` if the account was deleted, and
/// with `revoked` if this grant was revoked after the refresh token was issued
/// (`issued_at_s`, seconds since the epoch).
#[spacetimedb::reducer]
pub fn touch_account(ctx: &ReducerContext, gh_hash: String, grant: String, issued_at_s: u64) -> Result<(), String> {
    require_gate(ctx)?;
    check_len(&grant, 16, 64, "grant")?;
    ctx.db.account().gh_hash().find(&gh_hash).ok_or_else(|| "no_account".to_string())?;
    if let Some(r) = ctx.db.revoked_grant().grant().find(&grant) {
        let issued = Timestamp::from_micros_since_unix_epoch((issued_at_s.min(i64::MAX as u64 / 1_000_000) as i64) * 1_000_000);
        if issued <= r.revoked_at {
            return Err("revoked".into());
        }
    }
    Ok(())
}

/// Revoke a grant (one account through one OAuth client): its refresh tokens issued until
/// now stop working. Called by the gate's `/revoke` endpoint.
#[spacetimedb::reducer]
pub fn revoke_grant(ctx: &ReducerContext, gh_hash: String, grant: String) -> Result<(), String> {
    require_gate(ctx)?;
    check_len(&gh_hash, 16, 64, "gh_hash")?;
    check_len(&grant, 16, 64, "grant")?;
    ctx.db.revoked_grant().grant().delete(&grant);
    ctx.db.revoked_grant().insert(RevokedGrant { grant, gh_hash, revoked_at: ctx.timestamp });
    Ok(())
}

/// Seat a new priest. Any live priest of the same account departs first (takeover).
#[spacetimedb::reducer]
pub fn enter(
    ctx: &ReducerContext,
    session_id: String,
    priest_id: u64,
    gh_hash: String,
    budget: u64,
    tier: Tier,
    share: bool,
) -> Result<(), String> {
    require_gate(ctx)?;
    check_len(&session_id, 8, 64, "session_id")?;
    if priest_id == 0 {
        return Err("invalid_priest_id".into());
    }
    let budget = budget.clamp(c::BUDGET_MIN as u64, c::BUDGET_MAX as u64);
    let account = ctx.db.account().gh_hash().find(&gh_hash).ok_or("no_account")?;
    if ctx.db.session().session_id().find(&session_id).is_some()
        || ctx.db.session().priest_id().find(priest_id).is_some()
        || ctx.db.priest().priest_id().find(priest_id).is_some()
    {
        return Err("duplicate".into());
    }

    // Takeover: one live priest per account.
    let previous: Vec<Session> = ctx.db.session().identity().filter(account.identity).filter(|s| s.live).collect();
    for s in previous {
        do_depart(ctx, s, true);
    }

    if ctx.db.session().live().filter(true).count() >= c::MAX_LIVE_SESSIONS as usize {
        return Err("full".into());
    }

    let since = ctx.timestamp - ms(24 * 3_600_000);
    let recent: Vec<u64> = ctx.db.session().started_at().filter(since..).map(|s| s.budget).collect();
    let q = geometry::percentile(budget, &recent);

    let mutuals = live_mutuals(ctx, &account);
    let mutual_priests: Vec<(Account, Priest)> = mutuals
        .into_iter()
        .filter_map(|(a, s)| ctx.db.priest().priest_id().find(s.priest_id).map(|p| (a, p)))
        .collect();
    let positions: Vec<geometry::Pos> = mutual_priests
        .iter()
        .filter(|(_, p)| p.state != PriestState::Departing)
        .map(|(_, p)| (p.x, p.y))
        .collect();

    let seat = geometry::choose_seat(&positions, q, &mut |b| occupied_seats(ctx, b), &mut CtxRng(ctx))
        .ok_or("no_seat")?;
    let (x, y) = geometry::seat_pos(seat);

    ctx.db.session().insert(Session {
        session_id,
        identity: account.identity,
        priest_id,
        tier,
        share,
        budget,
        spent: 0,
        prayers: 0,
        started_at: ctx.timestamp,
        last_seen: ctx.timestamp,
        cancel_at: None,
        ended_at: None,
        live: true,
    });
    ctx.db.priest().insert(Priest {
        priest_id,
        x,
        y,
        bay: seat.bay,
        row: seat.row,
        half: seat.half,
        seat: seat.i,
        vestment: vestment_for(geometry::spend_tier(budget)),
        state: PriestState::Entering,
        state_since: ctx.timestamp,
        entered_at: ctx.timestamp,
        candle_id: 0,
    });

    // Hover labels: yourself, plus both directions for every live mutual.
    let my_label = label_of(&account);
    ctx.db.viewer_label_store().insert(ViewerLabel {
        id: 0,
        viewer: account.identity,
        priest_id,
        label: my_label.clone(),
    });
    for (other, p) in &mutual_priests {
        ctx.db.viewer_label_store().insert(ViewerLabel {
            id: 0,
            viewer: account.identity,
            priest_id: p.priest_id,
            label: label_of(other),
        });
        ctx.db.viewer_label_store().insert(ViewerLabel {
            id: 0,
            viewer: other.identity,
            priest_id,
            label: my_label.clone(),
        });
    }
    Ok(())
}

/// Record an accepted prayer: debit, tick, and per-viewer text.
#[spacetimedb::reducer]
pub fn post_prayer(ctx: &ReducerContext, session_id: String, text: String, tokens: u64, tier: Tier) -> Result<(), String> {
    require_gate(ctx)?;
    check_len(&text, 1, c::PRAYER_MAX_CHARS as usize, "text")?;
    let mut session = ctx.db.session().session_id().find(&session_id).ok_or("no_session")?;
    if !session.live {
        return Err("not_live".into());
    }
    session.spent = session.spent.saturating_add(tokens);
    session.prayers += 1;
    session.last_seen = ctx.timestamp;
    session.cancel_at = None;
    session.tier = tier;
    let share = session.share;
    let identity = session.identity;
    let priest_id = session.priest_id;
    ctx.db.session().session_id().update(session);

    let Some(mut priest) = ctx.db.priest().priest_id().find(priest_id) else {
        return Err("no_priest".into());
    };
    let seq = ctx.db.prayer_tick().priest_id().find(priest_id).map_or(1, |t| t.seq + 1);
    let tick = PrayerTick { priest_id, x: priest.x, seq, canned_idx: ctx.rng().r#gen::<u32>(), at: ctx.timestamp };
    if ctx.db.prayer_tick().priest_id().find(priest_id).is_some() {
        ctx.db.prayer_tick().priest_id().update(tick);
    } else {
        ctx.db.prayer_tick().insert(tick);
    }
    if priest.state == PriestState::Entering {
        priest.state = PriestState::Praying;
        priest.state_since = ctx.timestamp;
        ctx.db.priest().priest_id().update(priest);
    }

    add_prayer_text(ctx, identity, priest_id, seq, &text);
    if share {
        // viewer_label rows for this priest exist exactly for its owner and live mutuals.
        let viewers: HashSet<Identity> = ctx
            .db
            .viewer_label_store()
            .priest_id()
            .filter(priest_id)
            .map(|l| l.viewer)
            .filter(|v| *v != identity)
            .collect();
        for viewer in viewers {
            add_prayer_text(ctx, viewer, priest_id, seq, &text);
        }
    }
    Ok(())
}

#[spacetimedb::reducer]
pub fn heartbeat(ctx: &ReducerContext, session_id: String, cancel_at: Option<Timestamp>) -> Result<(), String> {
    require_gate(ctx)?;
    let mut session = ctx.db.session().session_id().find(&session_id).ok_or("no_session")?;
    if !session.live {
        return Err("not_live".into());
    }
    session.last_seen = ctx.timestamp;
    session.cancel_at = cancel_at;
    ctx.db.session().session_id().update(session);
    Ok(())
}

/// Explicit exit, budget spent, or disconnect detected by the gate. Idempotent.
#[spacetimedb::reducer]
pub fn depart(ctx: &ReducerContext, session_id: String) -> Result<(), String> {
    require_gate(ctx)?;
    if let Some(session) = ctx.db.session().session_id().find(&session_id) {
        do_depart(ctx, session, true);
    }
    Ok(())
}

/// Delete the account and every row that refers to it, except the candles it has lit:
/// those stay on their stands, with the name written on them, until they burn out.
#[spacetimedb::reducer]
pub fn forget(ctx: &ReducerContext, gh_hash: String) -> Result<(), String> {
    require_gate(ctx)?;
    if let Some(account) = ctx.db.account().gh_hash().find(&gh_hash) {
        let identity = account.identity;
        let sessions: Vec<Session> = ctx.db.session().identity().filter(identity).collect();
        for s in sessions {
            let id = s.session_id.clone();
            let priest_id = s.priest_id;
            do_depart(ctx, s, false);
            delete_viewer_rows(ctx, identity, priest_id);
            ctx.db.session().session_id().delete(&id);
        }
        // Candles already lit are not put out: they burn until `expire_candles` takes them.
        // Only the private record of whose they are goes, so nothing ties them to an account.
        ctx.db.candle_owner().identity().delete(identity);
        ctx.db.viewer_label_store().viewer().delete(identity);
        ctx.db.prayer_text_store().viewer().delete(identity);
        ctx.db.account().identity().delete(identity);
    }
    ctx.db.follow_edge().owner_hash().delete(&gh_hash);
    ctx.db.follow_edge().other_hash().delete(&gh_hash);
    ctx.db.revoked_grant().gh_hash().delete(&gh_hash);
    Ok(())
}

// ---------------------------------------------------------------------------
// Scheduled reducers
// ---------------------------------------------------------------------------

#[spacetimedb::reducer]
pub fn remove_priest(ctx: &ReducerContext, job: RemovePriestJob) -> Result<(), String> {
    require_internal(ctx)?;
    ctx.db.priest().priest_id().delete(job.priest_id);
    ctx.db.prayer_tick().priest_id().delete(job.priest_id);
    Ok(())
}

#[spacetimedb::reducer]
pub fn expire_candles(ctx: &ReducerContext, _job: ExpireCandlesJob) -> Result<(), String> {
    require_internal(ctx)?;
    let expired: Vec<u64> = ctx
        .db
        .candle()
        .expires_at()
        .filter(..=ctx.timestamp)
        .map(|c| c.candle_id)
        .collect();
    for id in expired {
        ctx.db.candle().candle_id().delete(id);
        ctx.db.candle_owner().candle_id().delete(id);
    }
    Ok(())
}

/// Gate-crash backstop: depart sessions not seen for 5 minutes.
#[spacetimedb::reducer]
pub fn reap_stale(ctx: &ReducerContext, _job: ReapStaleJob) -> Result<(), String> {
    require_internal(ctx)?;
    let cutoff = ctx.timestamp - ms(c::REAP_STALE_MS);
    let stale: Vec<Session> = ctx.db.session().live().filter(true).filter(|s| s.last_seen < cutoff).collect();
    for s in stale {
        do_depart(ctx, s, true);
    }
    Ok(())
}

/// Delete sessions 7 days after they end.
#[spacetimedb::reducer]
pub fn retention(ctx: &ReducerContext, _job: RetentionJob) -> Result<(), String> {
    require_internal(ctx)?;
    let cutoff = ctx.timestamp - ms(c::SESSION_RETENTION_DAYS * 86_400_000);
    let old: Vec<String> = ctx
        .db
        .session()
        .live()
        .filter(false)
        .filter(|s| s.ended_at.is_some_and(|e| e < cutoff))
        .map(|s| s.session_id)
        .collect();
    for id in old {
        ctx.db.session().session_id().delete(&id);
    }
    // A revoked grant only matters while a refresh token issued before it could still be
    // used: refresh tokens live 30 days.
    let lapsed = ctx.timestamp - ms(REFRESH_TOKEN_DAYS * 86_400_000);
    let old_grants: Vec<String> = ctx.db.revoked_grant().iter().filter(|r| r.revoked_at < lapsed).map(|r| r.grant).collect();
    for g in old_grants {
        ctx.db.revoked_grant().grant().delete(&g);
    }
    Ok(())
}

