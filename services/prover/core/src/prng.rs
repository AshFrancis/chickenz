/// Mulberry32 — deterministic 32-bit PRNG.
/// Pure function: returns (value_in_0_1, next_state).
///
/// Identical to the TypeScript implementation:
///   let t = (state + 0x6d2b79f5) | 0;
///   nextState = t >>> 0;
///   t = Math.imul(t ^ (t >>> 15), t | 1);
///   t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
///   value = ((t ^ (t >>> 14)) >>> 0) / 4294967296;
pub fn prng_next(state: u32) -> (f64, u32) {
    let mut t = state.wrapping_add(0x6d2b79f5);
    let next_state = t;
    t = (t ^ (t >> 15)).wrapping_mul(t | 1);
    t ^= t.wrapping_add((t ^ (t >> 7)).wrapping_mul(t | 61));
    let value = (t ^ (t >> 14)) as f64 / 4294967296.0;
    (value, next_state)
}

/// Returns a random integer in [min, max] inclusive.
pub fn prng_int_range(state: u32, min: i32, max: i32) -> (i32, u32) {
    let (value, next_state) = prng_next(state);
    let range = (max - min + 1) as f64;
    (min + (value * range).floor() as i32, next_state)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn prng_deterministic() {
        let (v1, s1) = prng_next(12345);
        let (v2, s2) = prng_next(12345);
        assert_eq!(v1, v2);
        assert_eq!(s1, s2);
    }

    #[test]
    fn prng_range_0_to_1() {
        let mut state = 42u32;
        for _ in 0..1000 {
            let (value, next) = prng_next(state);
            assert!((0.0..1.0).contains(&value), "value out of range: {}", value);
            state = next;
        }
    }

    #[test]
    fn prng_int_range_inclusive() {
        let mut state = 99u32;
        for _ in 0..1000 {
            let (value, next) = prng_int_range(state, 0, 3);
            assert!((0..=3).contains(&value), "value out of range: {}", value);
            state = next;
        }
    }

    #[test]
    fn prng_cross_validated_with_ts() {
        // Values from TypeScript sim: bun run services/prover/cross-validate.ts
        // seed=0
        let (v, s) = prng_next(0);
        assert_eq!(v, 0.26642920868471265);
        assert_eq!(s, 1831565813);
        let (v, s) = prng_next(s);
        assert_eq!(v, 0.0003297457005828619);
        assert_eq!(s, 3663131626);
        let (v, s) = prng_next(s);
        assert_eq!(v, 0.2232720274478197);
        assert_eq!(s, 1199730143);

        // seed=42
        let (v, s) = prng_next(42);
        assert_eq!(v, 0.6011037519201636);
        assert_eq!(s, 1831565855);
        let (v, s) = prng_next(s);
        assert_eq!(v, 0.44829055899754167);
        assert_eq!(s, 3663131668);
        let (v, _) = prng_next(s);
        assert_eq!(v, 0.8524657934904099);

        // seed=0xFFFFFFFF
        let (v, s) = prng_next(0xFFFFFFFF);
        assert_eq!(v, 0.8964226141106337);
        assert_eq!(s, 1831565812);

        // seed=0xDEADBEEF
        let (v, s) = prng_next(0xDEADBEEF);
        assert_eq!(v, 0.9413696140982211);
        assert_eq!(s, 1272527076);
    }

    #[test]
    fn prng_int_range_cross_validated_with_ts() {
        // From TS: intRange sequence starting at seed=42, range [0,3]
        let (v, s) = prng_int_range(42, 0, 3);
        assert_eq!(v, 2); assert_eq!(s, 1831565855);
        let (v, s) = prng_int_range(s, 0, 3);
        assert_eq!(v, 1); assert_eq!(s, 3663131668);
        let (v, s) = prng_int_range(s, 0, 3);
        assert_eq!(v, 3); assert_eq!(s, 1199730185);
        let (v, s) = prng_int_range(s, 0, 3);
        assert_eq!(v, 2); assert_eq!(s, 3031295998);
        let (v, s) = prng_int_range(s, 0, 3);
        assert_eq!(v, 0); assert_eq!(s, 567894515);
    }
}
