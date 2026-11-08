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
pub fn choose_seat(
    mutuals: &[Pos],
    q: f64,
    occupied: &mut dyn FnMut(i32) -> HashSet<SeatAddr>,
    rng: &mut dyn Rand,
) -> Option<SeatAddr> {
    if !mutuals.is_empty() {
        if let Some(seat) = choose_near_mutuals(mutuals, q, occupied, rng) {
            return Some(seat);
        }
    }
    choose_without_mutuals(q, occupied, rng)
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
        candidates.extend(bay_seats(b).filter(|s| !taken.contains(s)));
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
                .filter(|s| s.row == row && !taken.contains(s))
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

/// Arcades to try, starting with the primary one and moving outward; at each step the
/// arcade nearer to the priest (by x) is tried first.
pub fn arcade_search_order(primary: i32, priest_x: i32) -> impl Iterator<Item = i32> {
    std::iter::once(primary).chain((1..).flat_map(move |r: i32| {
        let mut pair = [primary - r, primary + r];
        pair.sort_by_key(|a| ((stand_x(*a) - priest_x).abs(), *a));
        pair
    }))
}

/// Lowest free slot index on a stand, given the slots in use.
pub fn lowest_free_slot(used: &HashSet<u8>) -> Option<u8> {
    (0..STAND_SLOTS).find(|s| !used.contains(s))
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
        assert_eq!(target_row(1.0), 0);
        assert_eq!(target_row(0.0), 3);
        assert_eq!(target_row(0.5), 2); // round(1.5) = 2
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
        assert_eq!(w.seat(1, &[], 0.0, &mut rng).row, 3);
    }

    #[test]
    fn falls_back_to_nearest_row_with_space() {
        let mut w = World::default();
        let mut rng = TestRng(11);
        for who in 0..16 {
            let s = w.seat(who, &[], 1.0, &mut rng);
            assert_eq!(s.row, 0);
        }
        assert_eq!(w.seat(99, &[], 1.0, &mut rng).row, 1);
    }

    #[test]
    fn mutual_newcomer_sits_next_to_friend_in_same_bay() {
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
            assert!(manhattan(seat_pos(a), seat_pos(b)) <= 2);
        }
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
                        let nearest = mutuals.iter().map(|m| manhattan(me, w.pos_of(*m))).min().unwrap();
                        assert!(nearest <= 4, "trial {trial}: nearest mutual {nearest} tiles away");
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
            let p = seat_pos(me);
            assert!([100, 101, 102].iter().any(|m| manhattan(p, w.pos_of(*m)) <= 4));
            assert!([100, 101, 102].iter().all(|m| bay_of_x(w.pos_of(*m).0) == me.bay));
        }
    }

    #[test]
    fn spread_mutuals_never_strand_newcomer_between_them() {
        let mut w = World::default();
        let mut rng = TestRng(9);
        for who in 0..(5 * c::BAY_SOFT_CAP as usize) {
            w.seat(who, &[], 0.5, &mut rng);
        }
        // Two unrelated friends far apart.
        let a = 3; // in bay 0
        let far = (0..5 * c::BAY_SOFT_CAP as usize)
            .find(|who| bay_of_x(w.pos_of(*who).0) == 2)
            .unwrap();
        let me = w.seat(9999, &[a, far], 0.5, &mut rng);
        let p = seat_pos(me);
        let nearest = [a, far].iter().map(|m| manhattan(p, w.pos_of(*m))).min().unwrap();
        assert!(nearest <= 4);
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
        // A right-half priest in bay 0 (x = 22) goes to arcade 1, then 0, 2, -1, 3.
        let order: Vec<i32> = arcade_search_order(1, 22).take(5).collect();
        assert_eq!(order, vec![1, 0, 2, -1, 3]);
        let mut used: HashSet<u8> = (0..STAND_SLOTS).collect();
        assert_eq!(lowest_free_slot(&used), None);
        used.remove(&17);
        assert_eq!(lowest_free_slot(&used), Some(17));
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
