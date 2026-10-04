// Suite: Harness.test - sanity checks for the test harness itself (task T1).
// Proves that Hypium runs and that assertions are evaluated; scripts/test.sh requires Tests run > 0.
import { describe, it, expect } from 'vitest';

function harnessTest() {
  describe('Harness', () => {
    it('runs_and_asserts', () => {
      expect(1 + 1).toBe(2);
    });
    it('compares_numbers', () => {
      expect(3).toBeGreaterThan(2);
      expect('CityTour').toContain('Tour');
    });
  });
}

harnessTest();
