//! Pure cathedral geometry: seat positions, seating, votive stands and spend tiers.
//!
//! Nothing here touches SpacetimeDB, so it is unit-tested natively (`cargo test`).

use crate::constants as c;
use std::collections::HashSet;

pub const LEFT: u8 = 0;
pub const RIGHT: u8 = 1;
pub const ROWS: u8 = c::ROW_Y.len() as u8;
pub const STAND_SLOTS: u8 = (c::STAND_TIERS * c::STAND_SLOTS_PER_TIER) as u8;

/// A seat address `(b, row, half, i)`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct SeatAddr {
    pub bay: i32,
    pub row: u8,
    pub half: u8,
    pub i: u8,
}

pub type Pos = (i32, i32);

/// World tile position of a seat.
pub fn seat_pos(s: SeatAddr) -> Pos {
    let base = c::BAY_W as i32 * s.bay;
    let local = if s.half == LEFT {
        c::LEFT_SEAT_X0 as i32 - s.i as i32
    } else {
        c::RIGHT_SEAT_X0 as i32 + s.i as i32
    };
    (base + local, c::ROW_Y[s.row as usize] as i32)
}

/// Bay index for a world x.
pub fn bay_of_x(x: i32) -> i32 {
    x.div_euclid(c::BAY_W as i32)
}

pub fn manhattan(a: Pos, b: Pos) -> i32 {
    (a.0 - b.0).abs() + (a.1 - b.1).abs()
}

/// All 64 seats of a bay.
pub fn bay_seats(bay: i32) -> impl Iterator<Item = SeatAddr> {
    (0..ROWS).flat_map(move |row| {
        [LEFT, RIGHT].into_iter().flat_map(move |half| {
            (0..c::SEATS_PER_HALF_ROW as u8).map(move |i| SeatAddr { bay, row, half, i })
        })
    })
}

/// Bays in visiting order 0, 1, -1, 2, -2, ...
pub fn bay_order() -> impl Iterator<Item = i32> {
    (0..).flat_map(|k: i32| if k == 0 { vec![0] } else { vec![k, -k] })
}

/// Minimal randomness interface so seating can be driven by `ctx.rng()` or a test RNG.
pub trait Rand {
    /// Uniform integer in `0..n` (`n > 0`).
    fn below(&mut self, n: usize) -> usize;
}

/// Budget percentile q(u) in [0, 1] among `others` (budgets of sessions started in
/// the last 24 hours, excluding u). Ties count half. With no history q = 0.5.
pub fn percentile(budget: u64, others: &[u64]) -> f64 {
    if others.is_empty() {
        return 0.5;
    }
    let less = others.iter().filter(|&&b| b < budget).count() as f64;
    let equal = others.iter().filter(|&&b| b == budget).count() as f64;
    ((less + 0.5 * equal) / others.len() as f64).clamp(0.0, 1.0)
}

/// Target row for an arrival with no live mutuals: round(3(1 - q)).
pub fn target_row(q: f64) -> u8 {
    ((ROWS as f64 - 1.0) * (1.0 - q.clamp(0.0, 1.0))).round() as u8
}

/// Choose a seat for a newcomer.
///
/// * `mutuals` — world positions of the newcomer's live mutuals.
/// * `q` — the newcomer's budget percentile.
/// * `occupied` — returns the seats taken in a bay by priests that are not departing.
///
/// With live mutuals the candidate set C is every free seat in a bay that holds a mutual
/// or neighbours one; the seat minimising `Σ d(s, p_v) + μ(1 − q)·row(s)` wins, ties at
/// random. Before scoring, C is narrowed to seats within `MUTUAL_NEAR_TILES` of at least
/// one mutual when any exist, so a newcomer never lands in the empty space between two
/// distant friends (every point between them has the same distance sum).
///
/// Without mutuals (or if every candidate bay is full) the first bay in the order
/// 0, 1, −1, … with fewer than `BAY_SOFT_CAP` live priests is used: a random free seat in
/// row round(3(1 − q)), else the nearest row with a free seat.
///
/// That seat is only a candidate. A second pass (`clear_seat`) then moves the priest, within
/// the same bay, to the nearest seat where the words over its head will not run into a
/// neighbour's.
pub fn choose_seat(
    mutuals: &[Pos],
    q: f64,
    occupied: &mut dyn FnMut(i32) -> HashSet<SeatAddr>,
    rng: &mut dyn Rand,
) -> Option<SeatAddr> {
    let candidate = if mutuals.is_empty() { None } else { choose_near_mutuals(mutuals, q, occupied, rng) }
        .or_else(|| choose_without_mutuals(q, occupied, rng))?;
    let taken = occupied(candidate.bay);
    Some(clear_seat(candidate, &taken, rng))
}

/// How far apart two priests in the same row must sit for their prayers not to collide:
/// a line of prayer is usually five to seven tiles wide, centred over the priest's head.
pub const PRAYER_CLEAR_X: i32 = 8;
/// And in the next row: the words of the priest behind are written across the row in front,
/// so nobody sits within this many tiles to either side, directly in front or behind.
pub const PRAYER_CLEAR_NEXT_ROW_X: i32 = 4;

/// Whether the prayers of priests at `a` and `b` are likely to run into each other.
pub fn crowds(a: Pos, b: Pos) -> bool {
    let dx = (a.0 - b.0).abs();
    let rows = (a.1 - b.1).abs() / c::PEW_STEP_Y as i32;
    match rows {
        0 => dx < PRAYER_CLEAR_X,
        1 => dx < PRAYER_CLEAR_NEXT_ROW_X,
        _ => false,
    }
}

/// The second pass of seating. Among the free seats of the candidate's bay, take one that
/// crowds the fewest priests already seated there (none, while the bay has room), and of
/// those the nearest to the candidate; ties at random. A candidate that crowds nobody
/// stays where it is.
pub fn clear_seat(candidate: SeatAddr, taken: &HashSet<SeatAddr>, rng: &mut dyn Rand) -> SeatAddr {
    let seated: Vec<Pos> = taken.iter().map(|s| seat_pos(*s)).collect();
    let from = seat_pos(candidate);
    let key = |s: &SeatAddr| -> (usize, i32) {
        let p = seat_pos(*s);
        (seated.iter().filter(|o| crowds(p, **o)).count(), manhattan(p, from))
    };
    let free: Vec<SeatAddr> = bay_seats(candidate.bay).filter(|s| !taken.contains(s)).collect();
    let Some(best) = free.iter().map(key).min() else { return candidate };
    let ties: Vec<SeatAddr> = free.into_iter().filter(|s| key(s) == best).collect();
    ties[rng.below(ties.len())]
}

/// Video only (`INDULGENCE_VIDEO_SEATING=1` at build time, see build.rs): a seat with no
/// other priest within two rows and six tiles, so that the words over each priest have room.
/// Otherwise every free seat will do.
#[cfg(video_seating)]
fn roomy(s: &SeatAddr, taken: &HashSet<SeatAddr>) -> bool {
    let p = seat_pos(*s);
    taken.iter().all(|o| {
        let q = seat_pos(*o);
        !((p.1 - q.1).abs() <= 4 && (p.0 - q.0).abs() <= 6)
    })
}
#[cfg(not(video_seating))]
fn roomy(_: &SeatAddr, _: &HashSet<SeatAddr>) -> bool {
    true
}

fn choose_near_mutuals(
    mutuals: &[Pos],
    q: f64,
    occupied: &mut dyn FnMut(i32) -> HashSet<SeatAddr>,
    rng: &mut dyn Rand,
) -> Option<SeatAddr> {
    let mut bays: Vec<i32> = mutuals
        .iter()
        .flat_map(|p| {
            let b = bay_of_x(p.0);
            [b - 1, b, b + 1]
        })
        .collect();
    bays.sort_unstable();
    bays.dedup();

    let mut candidates = Vec::new();
    for b in bays {
        let taken = occupied(b);
        candidates.extend(bay_seats(b).filter(|s| !taken.contains(s) && roomy(s, &taken)));
    }
    if candidates.is_empty() {
        return None;
    }

    let near: Vec<SeatAddr> = candidates
        .iter()
        .copied()
        .filter(|s| {
            let p = seat_pos(*s);
            mutuals.iter().any(|m| manhattan(p, *m) <= c::MUTUAL_NEAR_TILES as i32)
        })
        .collect();
    let pool = if near.is_empty() { candidates } else { near };

    let weight = c::SEATING_MU * (1.0 - q.clamp(0.0, 1.0));
    let score = |s: &SeatAddr| -> f64 {
        let p = seat_pos(*s);
        let dist: i32 = mutuals.iter().map(|m| manhattan(p, *m)).sum();
        dist as f64 + weight * s.row as f64
    };
    let best = pool.iter().map(score).fold(f64::INFINITY, f64::min);
    let ties: Vec<SeatAddr> = pool.into_iter().filter(|s| score(s) - best < 1e-9).collect();
    Some(ties[rng.below(ties.len())])
}

fn choose_without_mutuals(
    q: f64,
    occupied: &mut dyn FnMut(i32) -> HashSet<SeatAddr>,
    rng: &mut dyn Rand,
) -> Option<SeatAddr> {
    // A bay below the soft cap always has a free seat; the bound only guards against
    // a pathological caller.
    for bay in bay_order().take(1_000_000) {
        let taken = occupied(bay);
        if taken.len() >= c::BAY_SOFT_CAP as usize {
            continue;
        }
        let target = target_row(q) as i32;
        let mut rows: Vec<u8> = (0..ROWS).collect();
        rows.sort_by_key(|r| ((*r as i32 - target).abs(), *r));
        for row in rows {
            let free: Vec<SeatAddr> = bay_seats(bay)
                .filter(|s| s.row == row && !taken.contains(s) && roomy(s, &taken))
                .collect();
            if !free.is_empty() {
                return Some(free[rng.below(free.len())]);
            }
        }
    }
    None
}

// ---------------------------------------------------------------------------
// Votive stands
// ---------------------------------------------------------------------------

/// Arcade a departing priest walks to: arcade b for the left half, b + 1 for the right.
pub fn primary_arcade(bay: i32, half: u8) -> i32 {
    if half == LEFT { bay } else { bay + 1 }
}

/// World x of an arcade's stand centre.
pub fn stand_x(arcade: i32) -> i32 {
    c::BAY_W as i32 * arcade + c::STAND_CENTRE_X as i32
}

/// World tile of a candle slot (tier = slot / 10 steps back in x; position along y).
pub fn slot_pos(arcade: i32, slot: u8) -> Pos {
    let along = (slot as i64 % c::STAND_SLOTS_PER_TIER) as i32;
    let span = (c::STAND_Y[1] - c::STAND_Y[0] + 1) as i32;
    let y = c::STAND_Y[0] as i32 + along * span / c::STAND_SLOTS_PER_TIER as i32;
    (stand_x(arcade), y)
}

/// The stand on the other side of a priest's bay from the one it walks to first.
pub fn other_arcade(bay: i32, half: u8) -> i32 {
    if half == LEFT { bay + 1 } else { bay }
}

/// A candle on one of a bay's two stands, as far as choosing a place for a new one goes.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Burning {
    pub candle_id: u64,
    pub arcade: i32,
    pub slot: u8,
    /// False while the priest who placed it is still walking over to light it.
    pub lit: bool,
    pub expires_micros: i64,
}

/// Where a new candle goes, and which candle (if any) it takes the place of.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct CandlePlace {
    pub arcade: i32,
    pub slot: u8,
    pub replaces: Option<u64>,
}

/// Choose a place for a new candle: a free slot on the priest's own stand, picked at random
/// so a stand fills here and there rather than in a row; if that stand is full, a free slot
/// on the stand across the bay; and if both are full, the place of whichever candle on
/// either stand will burn out next. A candle that
/// is still being lit is passed over while any lit one remains, so nobody arrives at a
/// stand to find their place taken. Ties go to the priest's own stand, then the lower slot.
pub fn place_candle(primary: i32, other: i32, burning: &[Burning], rng: &mut impl Rand) -> Option<CandlePlace> {
    for arcade in [primary, other] {
        let used: HashSet<u8> = burning.iter().filter(|c| c.arcade == arcade).map(|c| c.slot).collect();
        let free = free_slots(&used);
        if !free.is_empty() {
            return Some(CandlePlace { arcade, slot: free[rng.below(free.len())], replaces: None });
        }
    }
    burning
        .iter()
        .filter(|c| c.arcade == primary || c.arcade == other)
        .min_by_key(|c| (!c.lit, c.expires_micros, c.arcade != primary, c.slot))
        .map(|c| CandlePlace { arcade: c.arcade, slot: c.slot, replaces: Some(c.candle_id) })
}

/// The free slots on a stand, lowest first, given the slots in use.
pub fn free_slots(used: &HashSet<u8>) -> Vec<u8> {
    (0..STAND_SLOTS).filter(|s| !used.contains(s)).collect()
}

// ---------------------------------------------------------------------------
// Spend tiers
// ---------------------------------------------------------------------------

/// Index into `SPEND_TIERS` for an amount of prayer tokens.
pub fn spend_tier(tokens: u64) -> usize {
    c::SPEND_TIERS
        .iter()
        .rposition(|t| tokens >= t.min)
        .unwrap_or(0)
}

pub fn burn_micros(tier: usize) -> i64 {
    c::SPEND_TIERS[tier].burn_h as i64 * 3_600_000_000
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    /// Small deterministic xorshift RNG for tests.
    struct TestRng(u64);
    impl Rand for TestRng {
        fn below(&mut self, n: usize) -> usize {
            self.0 ^= self.0 << 13;
            self.0 ^= self.0 >> 7;
            self.0 ^= self.0 << 17;
            (self.0 % n as u64) as usize
        }
    }

    /// A toy cathedral: seat -> owner.
    #[derive(Default)]
    struct World {
        seats: HashMap<SeatAddr, usize>,
    }
    impl World {
        fn occupied(&self) -> impl FnMut(i32) -> HashSet<SeatAddr> + '_ {
            move |b| self.seats.keys().filter(|s| s.bay == b).copied().collect()
        }
        fn pos_of(&self, who: usize) -> Pos {
            seat_pos(*self.seats.iter().find(|(_, w)| **w == who).unwrap().0)
        }
        fn seat(&mut self, who: usize, mutuals: &[usize], q: f64, rng: &mut TestRng) -> SeatAddr {
            let pos: Vec<Pos> = mutuals.iter().map(|m| self.pos_of(*m)).collect();
            let s = choose_seat(&pos, q, &mut self.occupied(), rng).expect("seat");
            assert!(self.seats.insert(s, who).is_none(), "double-booked {s:?}");
            s
        }
    }

    #[test]
    fn seat_positions_match_spec() {
        let s = SeatAddr { bay: 0, row: 0, half: LEFT, i: 0 };
        assert_eq!(seat_pos(s), (15, 6));
        assert_eq!(seat_pos(SeatAddr { i: 7, ..s }), (8, 6));
        assert_eq!(seat_pos(SeatAddr { half: RIGHT, ..s }), (19, 6));
        assert_eq!(seat_pos(SeatAddr { half: RIGHT, i: 7, ..s }), (26, 6));
        assert_eq!(seat_pos(SeatAddr { bay: -2, row: 3, half: RIGHT, i: 1 }), (-60 + 20, 12));
        assert_eq!(bay_seats(5).count(), c::SEATS_PER_BAY as usize);
        assert_eq!(bay_of_x(-1), -1);
        assert_eq!(bay_of_x(29), 0);
        assert_eq!(bay_of_x(30), 1);
    }

    #[test]
    fn bay_order_alternates() {
        let v: Vec<i32> = bay_order().take(5).collect();
        assert_eq!(v, vec![0, 1, -1, 2, -2]);
    }

    #[test]
    fn percentile_and_rows() {
        assert_eq!(percentile(10, &[]), 0.5);
        assert_eq!(percentile(10, &[1, 2, 3]), 1.0);
        assert_eq!(percentile(1, &[5, 6]), 0.0);
        assert_eq!(percentile(5, &[5, 5]), 0.5);
        let last = ROWS - 1;
        assert_eq!(target_row(1.0), 0);
        assert_eq!(target_row(0.0), last);
        assert_eq!(target_row(0.5), ((last as f64) * 0.5).round() as u8);
    }

    #[test]
    fn strangers_fill_bay_zero_to_soft_cap_then_move_on() {
        let mut w = World::default();
        let mut rng = TestRng(7);
        for who in 0..c::BAY_SOFT_CAP as usize {
            assert_eq!(w.seat(who, &[], 0.5, &mut rng).bay, 0);
        }
        assert_eq!(w.seat(1000, &[], 0.5, &mut rng).bay, 1);
        assert_eq!(w.seat(1001, &[], 0.5, &mut rng).bay, 1);
    }

    #[test]
    fn high_spend_sits_forward() {
        let mut w = World::default();
        let mut rng = TestRng(3);
        assert_eq!(w.seat(0, &[], 1.0, &mut rng).row, 0);
        assert_eq!(w.seat(1, &[], 0.0, &mut rng).row, ROWS - 1);
    }

    #[test]
    fn falls_back_to_nearest_row_with_space() {
        let mut w = World::default();
        let mut rng = TestRng(11);
        // The first pass alone: the candidate is in the target row until that row is full.
        for who in 0..16 {
            let s = choose_without_mutuals(1.0, &mut w.occupied(), &mut rng).expect("seat");
            assert_eq!(s.row, 0);
            w.seats.insert(s, who);
        }
        assert_eq!(choose_without_mutuals(1.0, &mut w.occupied(), &mut rng).expect("seat").row, 1);
    }

    #[test]
    fn mutual_newcomer_sits_near_friend_in_same_bay() {
        let mut rng = TestRng(42);
        for seed_q in [0.0, 0.3, 0.7, 1.0] {
            let mut w = World::default();
            // Some strangers first, so the friend is not alone.
            for who in 0..20 {
                w.seat(who, &[], 0.5, &mut rng);
            }
            let a = w.seat(100, &[], seed_q, &mut rng);
            let b = w.seat(101, &[100], 1.0 - seed_q, &mut rng);
            assert_eq!(a.bay, b.bay, "mutuals must share a bay");
            assert!(!crowds(seat_pos(a), seat_pos(b)), "but not so close that their prayers collide");
        }
    }

    #[test]
    fn prayers_collide_only_when_close() {
        let at = |x: i32, row: usize| (x, c::ROW_Y[row] as i32);
        // The same row: eight tiles apart is clear, seven is not.
        assert!(crowds(at(8, 2), at(15, 2)));
        assert!(!crowds(at(8, 2), at(16, 2)));
        // The next row, in front or behind: four tiles to the side is clear.
        assert!(crowds(at(10, 2), at(13, 3)));
        assert!(crowds(at(10, 3), at(10, 2)));
        assert!(!crowds(at(10, 2), at(14, 3)));
        // Two rows apart never collide.
        assert!(!crowds(at(10, 2), at(10, 4)));
    }

    #[test]
    fn second_pass_moves_a_crowded_candidate_to_the_nearest_clear_seat() {
        let mut rng = TestRng(7);
        let friend = SeatAddr { bay: 3, row: 4, half: LEFT, i: 2 };
        let taken: HashSet<SeatAddr> = [friend].into_iter().collect();
        // Right beside the friend: moved, but only as far as it takes, and in the same bay.
        let beside = SeatAddr { bay: 3, row: 4, half: LEFT, i: 3 };
        for _ in 0..50 {
            let s = clear_seat(beside, &taken, &mut rng);
            assert_eq!(s.bay, 3);
            assert!(!taken.contains(&s));
            assert!(!crowds(seat_pos(s), seat_pos(friend)));
            assert_eq!(manhattan(seat_pos(s), seat_pos(beside)), 4, "two rows in front or behind: {s:?}");
        }
        // A candidate that crowds nobody is left alone.
        let far = SeatAddr { bay: 3, row: 0, half: RIGHT, i: 6 };
        assert_eq!(clear_seat(far, &taken, &mut rng), far);
        // Priests in other bays do not count.
        let elsewhere: HashSet<SeatAddr> = HashSet::new();
        assert_eq!(clear_seat(beside, &elsewhere, &mut rng), beside);
    }

    #[test]
    fn the_first_priests_in_a_bay_never_have_colliding_prayers() {
        let mut rng = TestRng(2024);
        for _ in 0..30 {
            let mut w = World::default();
            // (About a dozen fit this way; after that some overlap cannot be helped.)
            for who in 0..8 {
                w.seat(who, &[], (rng.below(101) as f64) / 100.0, &mut rng);
            }
            let seats: Vec<SeatAddr> = w.seats.keys().copied().collect();
            for (i, a) in seats.iter().enumerate() {
                assert_eq!(a.bay, 0);
                for b in &seats[i + 1..] {
                    assert!(!crowds(seat_pos(*a), seat_pos(*b)), "{a:?} crowds {b:?}");
                }
            }
        }
    }

    #[test]
    fn a_crowded_bay_still_seats_everyone_with_as_little_overlap_as_it_can() {
        let mut rng = TestRng(11);
        let mut w = World::default();
        for who in 0..c::BAY_SOFT_CAP as usize {
            let s = w.seat(who, &[], 0.5, &mut rng);
            assert_eq!(s.bay, 0, "the bay fills to its cap before the next is used");
        }
        assert_eq!(w.seat(1000, &[], 0.5, &mut rng).bay, 1);
    }

    #[test]
    fn mutuals_in_a_far_bay_pull_newcomer_there() {
        let mut w = World::default();
        let mut rng = TestRng(5);
        // Fill bays 0, 1, -1 so the friend lands in bay 2.
        for who in 0..(3 * c::BAY_SOFT_CAP as usize) {
            w.seat(who, &[], 0.5, &mut rng);
        }
        let friend = w.seat(500, &[], 0.5, &mut rng);
        assert_eq!(friend.bay, 2);
        let me = w.seat(501, &[500], 0.5, &mut rng);
        assert_eq!(me.bay, 2);
    }

    /// Acceptance check: with 3 or more mutuals present, the newcomer sits within 4 tiles
    /// of at least one of them — whenever such a seat is free. (When every seat within
    /// 4 tiles of every mutual is taken no placement can satisfy it.)
    #[test]
    fn newcomer_with_three_or_more_mutuals_sits_within_four_tiles_of_one() {
        let mut rng = TestRng(1234);
        let mut checked = 0;
        for trial in 0..200u64 {
            let mut w = World::default();
            let mut next = 0usize;
            let mut groups: Vec<Vec<usize>> = vec![Vec::new(); 4];
            for _ in 0..120 {
                let q = (rng.below(101) as f64) / 100.0;
                let g = rng.below(6);
                let who = next;
                next += 1;
                if g < groups.len() {
                    let mutuals = groups[g].clone();
                    let near_free = mutuals.len() >= 3 && {
                        let pos: Vec<Pos> = mutuals.iter().map(|m| w.pos_of(*m)).collect();
                        pos.iter().any(|p| {
                            let b = bay_of_x(p.0);
                            (b - 1..=b + 1).flat_map(bay_seats).any(|s| {
                                !w.seats.contains_key(&s) && manhattan(seat_pos(s), *p) <= 4
                            })
                        })
                    };
                    w.seat(who, &mutuals, q, &mut rng);
                    if near_free {
                        checked += 1;
                        let me = w.pos_of(who);
                        // The candidate seat is within 4 tiles of a mutual, so in that mutual's
                        // bay or the one beside it; the second pass never leaves that bay.
                        let nearest = mutuals.iter().map(|m| (bay_of_x(me.0) - bay_of_x(w.pos_of(*m).0)).abs()).min().unwrap();
                        assert!(nearest <= 1, "trial {trial}: nearest mutual {nearest} bays away");
                    }
                    groups[g].push(who);
                } else {
                    w.seat(who, &[], q, &mut rng);
                }
            }
        }
        assert!(checked > 1000, "property exercised {checked} times");
    }

    #[test]
    fn third_mutual_joins_the_group() {
        let mut rng = TestRng(99);
        for _ in 0..50 {
            let mut w = World::default();
            for who in 0..30 {
                w.seat(who, &[], 0.5, &mut rng);
            }
            w.seat(100, &[], 0.2, &mut rng);
            w.seat(101, &[100], 0.9, &mut rng);
            w.seat(102, &[100, 101], 0.5, &mut rng);
            let me = w.seat(103, &[100, 101, 102], 0.1, &mut rng);
            assert!([100, 101, 102].iter().all(|m| bay_of_x(w.pos_of(*m).0) == me.bay));
        }
    }

    #[test]
    fn spread_mutuals_never_strand_newcomer_between_them() {
        let mut w = World::default();
        let mut rng = TestRng(9);
        // Two unrelated friends far apart, in bays 0 and 2, among a few strangers.
        w.seats.insert(SeatAddr { bay: 0, row: 2, half: LEFT, i: 3 }, 1);
        w.seats.insert(SeatAddr { bay: 2, row: 5, half: RIGHT, i: 2 }, 2);
        for who in 10..40 {
            w.seat(who, &[], 0.5, &mut rng);
        }
        for _ in 0..20 {
            let me = w.seat(9999, &[1, 2], 0.5, &mut rng);
            let p = seat_pos(me);
            assert!([0, 2].contains(&bay_of_x(p.0)), "newcomer in bay {}, between its friends", bay_of_x(p.0));
            w.seats.remove(&me);
        }
    }

    #[test]
    fn full_neighbourhood_falls_back_to_stranger_rule() {
        let mut w = World::default();
        let mut rng = TestRng(77);
        // Fill bays -2..=2 completely; the friend sits in bay 0, so every candidate
        // bay (-1, 0, 1) is full and the stranger rule applies: order 0, 1, -1, 2, -2, 3.
        let mut who = 0;
        let mut friend = None;
        for b in -2..=2 {
            for s in bay_seats(b) {
                w.seats.insert(s, who);
                if b == 0 && friend.is_none() {
                    friend = Some(who);
                }
                who += 1;
            }
        }
        let s = w.seat(who, &[friend.unwrap()], 0.5, &mut rng);
        assert_eq!(s.bay, 3, "first non-full bay in visiting order");
    }

    #[test]
    fn stands_and_slots() {
        assert_eq!(primary_arcade(3, LEFT), 3);
        assert_eq!(primary_arcade(3, RIGHT), 4);
        assert_eq!(stand_x(0), 2);
        assert_eq!(stand_x(-1), -28);
        assert_eq!(slot_pos(0, 0), (2, 7));
        assert_eq!(slot_pos(0, 9).1, 11);
        assert_eq!(other_arcade(3, LEFT), 4);
        assert_eq!(other_arcade(3, RIGHT), 3);
        let mut used: HashSet<u8> = (0..STAND_SLOTS).collect();
        assert!(free_slots(&used).is_empty());
        used.remove(&17);
        used.remove(&3);
        assert_eq!(free_slots(&used), vec![3, 17]);
    }

    #[test]
    fn a_new_candle_finds_a_place() {
        let candle = |id: u64, arcade: i32, slot: u8, expires: i64| Burning { candle_id: id, arcade, slot, lit: true, expires_micros: expires };
        let full = |arcade: i32, first_id: u64| -> Vec<Burning> {
            (0..STAND_SLOTS).map(|s| candle(first_id + s as u64, arcade, s, 1_000 + s as i64)).collect()
        };
        let mut rng = TestRng(0x9E3779B97F4A7C15);

        // An empty stand: somewhere on the priest's own, and not always the same place.
        let mut seen = HashSet::new();
        for _ in 0..400 {
            let p = place_candle(1, 0, &[], &mut rng).unwrap();
            assert_eq!((p.arcade, p.replaces), (1, None));
            assert!(p.slot < STAND_SLOTS);
            seen.insert(p.slot);
        }
        assert_eq!(seen.len(), STAND_SLOTS as usize, "every slot is used sooner or later");

        // Filling a stand one candle at a time never puts two in one slot, and takes all 40
        // before any goes to the other side.
        let mut stand: Vec<Burning> = Vec::new();
        for i in 0..STAND_SLOTS as u64 {
            let p = place_candle(1, 0, &stand, &mut rng).unwrap();
            assert_eq!((p.arcade, p.replaces), (1, None));
            assert!(stand.iter().all(|c| c.slot != p.slot));
            stand.push(candle(i, 1, p.slot, 1_000 + i as i64));
        }
        let first_order: Vec<u8> = stand.iter().map(|c| c.slot).collect();
        assert_ne!(first_order, (0..STAND_SLOTS).collect::<Vec<u8>>(), "not filled in a row");

        // Its own stand full: the other side of the bay, not a stand further off.
        let p = place_candle(1, 0, &stand, &mut rng).unwrap();
        assert_eq!((p.arcade, p.replaces), (0, None));
        // One slot left there: that one.
        let mut nearly: Vec<Burning> = stand.clone();
        nearly.extend(full(0, 200).into_iter().filter(|c| c.slot != 23));
        assert_eq!(place_candle(1, 0, &nearly, &mut rng), Some(CandlePlace { arcade: 0, slot: 23, replaces: None }));

        // Both full: the place of the candle that will burn out next, on either stand.
        let mut both: Vec<Burning> = full(1, 100).into_iter().chain(full(0, 200)).collect();
        both[57].expires_micros = 7; // arcade 0, slot 17
        assert_eq!(place_candle(1, 0, &both, &mut rng), Some(CandlePlace { arcade: 0, slot: 17, replaces: Some(217) }));
        // A candle still being lit is passed over, even if it would be next.
        both[57].lit = false;
        assert_eq!(place_candle(1, 0, &both, &mut rng), Some(CandlePlace { arcade: 1, slot: 0, replaces: Some(100) }));
        // A tie goes to the priest's own stand.
        let tied: Vec<Burning> = both.iter().map(|c| Burning { lit: true, expires_micros: 9, ..*c }).collect();
        assert_eq!(place_candle(1, 0, &tied, &mut rng), Some(CandlePlace { arcade: 1, slot: 0, replaces: Some(100) }));
        assert_eq!(place_candle(0, 1, &tied, &mut rng), Some(CandlePlace { arcade: 0, slot: 0, replaces: Some(200) }));
        // Candles on other stands never count.
        let p = place_candle(5, 6, &both, &mut rng).unwrap();
        assert_eq!((p.arcade, p.replaces), (5, None));
    }

    #[test]
    fn spend_tiers() {
        assert_eq!(spend_tier(0), 0);
        assert_eq!(spend_tier(9_999), 0);
        assert_eq!(spend_tier(10_000), 1);
        assert_eq!(spend_tier(49_999), 1);
        assert_eq!(spend_tier(50_000), 2);
        assert_eq!(spend_tier(200_000), 3);
        assert_eq!(burn_micros(0), 24 * 3_600_000_000);
        assert_eq!(burn_micros(3), 48 * 3_600_000_000);
    }
}
