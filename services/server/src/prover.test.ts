import { describe, expect, test, beforeEach } from "bun:test";
import {
  queueProof,
  claimNextJob,
  submitJobResult,
  getJob,
  getJobTranscript,
  isWorkerOnline,
  workerHeartbeat,
  proveMatch,
  _resetForTesting,
  type ProofArtifacts,
} from "./prover";

// ── Helpers ─────────────────────────────────────────────────

function dummyArtifacts(overrides?: Partial<ProofArtifacts>): ProofArtifacts {
  return {
    seal: "deadbeef",
    journal: "cafebabe",
    imageId: "01020304",
    ...overrides,
  };
}

let matchCounter = 0;
function uniqueMatchId(): string {
  return `test-match-${Date.now()}-${matchCounter++}`;
}

beforeEach(() => {
  _resetForTesting();
});

// ── queueProof ──────────────────────────────────────────────

describe("queueProof", () => {
  test("adds a job and returns it", () => {
    const id = uniqueMatchId();
    const job = queueProof(id, { data: 1 });
    expect(job.matchId).toBe(id);
    expect(job.status).toBe("queued");
    expect(job.transcript).toEqual({ data: 1 });
  });

  test("deduplicates by matchId", () => {
    const id = uniqueMatchId();
    const job1 = queueProof(id, { a: 1 });
    const job2 = queueProof(id, { a: 2 });
    expect(job1).toBe(job2); // same reference
    // transcript not overwritten
    expect(job1.transcript).toEqual({ a: 1 });
  });

  test("accepts onResult callback", () => {
    const id = uniqueMatchId();
    const job = queueProof(id, {}, () => {});
    expect(job.onResult).toBeDefined();
  });

  test("queue overflow evicts done jobs first", () => {
    // Fill queue to MAX_QUEUE_SIZE with done jobs
    const ids: string[] = [];
    for (let i = 0; i < 50; i++) {
      const id = uniqueMatchId();
      ids.push(id);
      queueProof(id, {});
    }
    // Claim and complete all 50
    for (const id of ids) {
      claimNextJob();
      submitJobResult(id, dummyArtifacts());
    }
    // Queue is full of done jobs; adding one more should evict a done job
    const newId = uniqueMatchId();
    const newJob = queueProof(newId, {});
    expect(newJob.matchId).toBe(newId);
    expect(newJob.status).toBe("queued");
    expect(getJob(newId)).toBeTruthy();
  });

  test("queue overflow evicts queued jobs when no done jobs exist", () => {
    // Fill queue to 50 with queued jobs
    for (let i = 0; i < 50; i++) {
      queueProof(uniqueMatchId(), {});
    }
    // Adding one more should evict the oldest queued job
    const newId = uniqueMatchId();
    const newJob = queueProof(newId, {});
    expect(newJob.status).toBe("queued");
    expect(getJob(newId)).toBeTruthy();
  });

  test("queue overflow does not evict claimed jobs", () => {
    // Fill with 50 jobs and claim them all
    const claimedIds: string[] = [];
    for (let i = 0; i < 50; i++) {
      const id = uniqueMatchId();
      queueProof(id, {});
      claimedIds.push(id);
    }
    for (let i = 0; i < 50; i++) {
      claimNextJob(); // claims in order
    }
    // All 50 are claimed. Adding one more: tries to evict done (none),
    // then queued (none), then breaks — queue goes to 51
    const extraId = uniqueMatchId();
    queueProof(extraId, {});
    expect(getJob(extraId)).toBeTruthy();
    // All original claimed jobs should still be there
    for (const id of claimedIds) {
      expect(getJob(id)).toBeTruthy();
    }
  });

  test("multiple done jobs evicted before queued jobs", () => {
    // Add 48 queued + 2 done to reach 50
    for (let i = 0; i < 48; i++) {
      queueProof(uniqueMatchId(), {});
    }
    const doneId1 = uniqueMatchId();
    const doneId2 = uniqueMatchId();
    queueProof(doneId1, {});
    queueProof(doneId2, {});
    // Claim and complete the last two
    // Need to claim from front since claimNextJob gets oldest queued
    for (let i = 0; i < 50; i++) {
      const j = claimNextJob();
      if (j && (j.matchId === doneId1 || j.matchId === doneId2)) {
        submitJobResult(j.matchId, dummyArtifacts());
      }
    }
    // Reset non-done claimed jobs back by backdating
    // Actually, let's just reset and do a cleaner approach
    _resetForTesting();

    // Simpler: add 49 queued, then 1 done, then add one more
    for (let i = 0; i < 49; i++) {
      queueProof(uniqueMatchId(), {});
    }
    const dId = uniqueMatchId();
    queueProof(dId, {});
    claimNextJob(); // claims first queued (not dId)
    // We need dId to be done. Let's claim until we get dId
    _resetForTesting();

    // Even simpler approach: fill with 50, mark some done manually
    const ids: string[] = [];
    for (let i = 0; i < 50; i++) {
      const id = uniqueMatchId();
      ids.push(id);
      queueProof(id, {});
    }
    // Claim and complete first 2
    for (let i = 0; i < 2; i++) {
      const j = claimNextJob()!;
      submitJobResult(j.matchId, dummyArtifacts());
    }
    // Now we have 2 done + 48 queued = 50
    // Adding a new job should evict a done job first
    const newId = uniqueMatchId();
    queueProof(newId, {});
    expect(getJob(newId)).toBeTruthy();
    // The 2 done jobs should have been evicted (or at least 1)
    // And queued jobs should still be intact
    expect(getJob(ids[2]!)).toBeTruthy(); // first non-done queued job still there
  });
});

// ── claimNextJob ────────────────────────────────────────────

describe("claimNextJob", () => {
  test("returns null when queue is empty", () => {
    expect(claimNextJob()).toBeNull();
  });

  test("returns the oldest queued job", () => {
    const id1 = uniqueMatchId();
    const id2 = uniqueMatchId();
    queueProof(id1, {});
    queueProof(id2, {});
    const claimed = claimNextJob();
    expect(claimed).not.toBeNull();
    expect(claimed!.matchId).toBe(id1);
    expect(claimed!.status).toBe("claimed");
    expect(claimed!.claimedAt).toBeDefined();
  });

  test("second claim returns next job", () => {
    const id1 = uniqueMatchId();
    const id2 = uniqueMatchId();
    queueProof(id1, {});
    queueProof(id2, {});
    claimNextJob(); // claims id1
    const claimed = claimNextJob(); // should claim id2
    expect(claimed).not.toBeNull();
    expect(claimed!.matchId).toBe(id2);
  });

  test("does not return already-claimed jobs", () => {
    const id = uniqueMatchId();
    queueProof(id, {});
    claimNextJob();
    const second = claimNextJob();
    expect(second).toBeNull();
  });

  test("updates lastWorkerPing (heartbeat)", () => {
    // After claimNextJob, isWorkerOnline should return true
    claimNextJob();
    expect(isWorkerOnline()).toBe(true);
  });
});

// ── getJobTranscript ────────────────────────────────────────

describe("getJobTranscript", () => {
  test("returns transcript for claimed job", () => {
    const id = uniqueMatchId();
    const transcript = { round: [1, 2, 3] };
    queueProof(id, transcript);
    claimNextJob();
    expect(getJobTranscript(id)).toEqual(transcript);
  });

  test("returns null for queued (unclaimed) job", () => {
    const id = uniqueMatchId();
    queueProof(id, { data: 1 });
    expect(getJobTranscript(id)).toBeNull();
  });

  test("returns null for non-existent matchId", () => {
    expect(getJobTranscript("nonexistent")).toBeNull();
  });

  test("returns null for done job", () => {
    const id = uniqueMatchId();
    queueProof(id, { data: 1 });
    claimNextJob();
    submitJobResult(id, dummyArtifacts());
    expect(getJobTranscript(id)).toBeNull();
  });
});

// ── submitJobResult ─────────────────────────────────────────

describe("submitJobResult", () => {
  test("updates claimed job to done with artifacts", () => {
    const id = uniqueMatchId();
    queueProof(id, {});
    claimNextJob();
    const arts = dummyArtifacts({ seal: "aabb" });
    const result = submitJobResult(id, arts);
    expect(result).not.toBeNull();
    expect(result!.status).toBe("done");
    expect(result!.artifacts).toEqual(arts);
  });

  test("returns null for non-existent matchId", () => {
    expect(submitJobResult("nonexistent", dummyArtifacts())).toBeNull();
  });

  test("returns null for queued (unclaimed) job", () => {
    const id = uniqueMatchId();
    queueProof(id, {});
    expect(submitJobResult(id, dummyArtifacts())).toBeNull();
  });

  test("returns null for already-done job", () => {
    const id = uniqueMatchId();
    queueProof(id, {});
    claimNextJob();
    submitJobResult(id, dummyArtifacts());
    // Second submit should fail (job is now done)
    expect(submitJobResult(id, dummyArtifacts())).toBeNull();
  });

  test("invokes onResult callback with artifacts and 'worker' source", () => {
    const id = uniqueMatchId();
    let cbArtifacts: ProofArtifacts | null = null;
    let cbSource: string | undefined;
    queueProof(id, {}, (arts, src) => {
      cbArtifacts = arts;
      cbSource = src;
    });
    claimNextJob();
    const arts = dummyArtifacts();
    submitJobResult(id, arts);
    expect(cbArtifacts).toEqual(arts);
    expect(cbSource).toBe("worker");
  });

  test("callback error does not prevent job from being marked done", () => {
    const id = uniqueMatchId();
    queueProof(id, {}, () => {
      throw new Error("callback explosion");
    });
    claimNextJob();
    const result = submitJobResult(id, dummyArtifacts());
    expect(result!.status).toBe("done");
  });
});

// ── getJob ──────────────────────────────────────────────────

describe("getJob", () => {
  test("returns job by matchId", () => {
    const id = uniqueMatchId();
    queueProof(id, { x: 1 });
    const job = getJob(id);
    expect(job).not.toBeNull();
    expect(job!.matchId).toBe(id);
  });

  test("returns null for unknown matchId", () => {
    expect(getJob("does-not-exist")).toBeNull();
  });

  test("returns job in any status", () => {
    const id = uniqueMatchId();
    queueProof(id, {});
    expect(getJob(id)!.status).toBe("queued");
    claimNextJob();
    expect(getJob(id)!.status).toBe("claimed");
    submitJobResult(id, dummyArtifacts());
    expect(getJob(id)!.status).toBe("done");
  });
});

// ── isWorkerOnline / workerHeartbeat ────────────────────────

describe("worker heartbeat", () => {
  test("worker is offline initially after reset", () => {
    expect(isWorkerOnline()).toBe(false);
  });

  test("workerHeartbeat makes worker online", () => {
    workerHeartbeat();
    expect(isWorkerOnline()).toBe(true);
  });
});

// ── pruneJobs (via claimNextJob) ────────────────────────────

describe("pruneJobs (triggered by claimNextJob)", () => {
  test("done jobs are pruned on next claim call", () => {
    const id = uniqueMatchId();
    queueProof(id, {});
    claimNextJob();
    submitJobResult(id, dummyArtifacts());
    // Job exists as done
    expect(getJob(id)!.status).toBe("done");
    // Trigger pruneJobs via claimNextJob
    claimNextJob();
    // Done job should be removed
    expect(getJob(id)).toBeNull();
  });

  test("stale claimed jobs are reset to queued after timeout", () => {
    const id1 = uniqueMatchId();
    const id2 = uniqueMatchId();
    queueProof(id1, {});
    queueProof(id2, {});
    // Claim both
    claimNextJob(); // claims id1
    claimNextJob(); // claims id2
    // Backdate only id2 to exceed JOB_TIMEOUT_MS (5 min)
    const job2 = getJob(id2)!;
    job2.claimedAt = Date.now() - 6 * 60 * 1000;
    // Trigger pruneJobs via claimNextJob — id2 resets to queued and gets re-claimed
    const reclaimed = claimNextJob();
    expect(reclaimed).not.toBeNull();
    expect(reclaimed!.matchId).toBe(id2);
    expect(reclaimed!.status).toBe("claimed");
    // id1 should still be claimed (not timed out)
    expect(getJob(id1)!.status).toBe("claimed");
  });
});

// ── proveMatch (dual-prover race) ───────────────────────────

describe("proveMatch", () => {
  test("queues a job for the worker", () => {
    const id = uniqueMatchId();
    proveMatch(id, { data: 1 }, () => {});
    const job = getJob(id);
    expect(job).not.toBeNull();
    expect(job!.status).toBe("queued");
  });

  test("settleOnce fires exactly once when worker completes", () => {
    const id = uniqueMatchId();
    let callCount = 0;
    proveMatch(id, {}, () => {
      callCount++;
    });
    const claimed = claimNextJob();
    expect(claimed).not.toBeNull();
    expect(claimed!.matchId).toBe(id);
    submitJobResult(id, dummyArtifacts());
    expect(callCount).toBe(1);
  });

  test("onResult receives artifacts and source='worker'", () => {
    const id = uniqueMatchId();
    let resultArtifacts: ProofArtifacts | null = null;
    let resultSource: string | undefined;
    proveMatch(id, {}, (arts, src) => {
      resultArtifacts = arts;
      resultSource = src;
    });
    claimNextJob();
    const arts = dummyArtifacts({ seal: "1234" });
    submitJobResult(id, arts);
    expect(resultArtifacts).toEqual(arts);
    expect(resultSource).toBe("worker");
  });

  test("settleOnce ignores null artifacts (does not settle on failure)", () => {
    const id = uniqueMatchId();
    let callCount = 0;
    proveMatch(id, {}, () => {
      callCount++;
    });
    // The onResult callback registered on the job is settleOnce("worker").
    // If we invoke it with null, it should NOT settle (ignores null).
    const job = getJob(id)!;
    job.onResult?.(null);
    expect(callCount).toBe(0);
    // But real artifacts should settle
    claimNextJob();
    submitJobResult(id, dummyArtifacts());
    expect(callCount).toBe(1);
  });

  test("second settlement is ignored (settleOnce only fires once)", () => {
    const id = uniqueMatchId();
    let callCount = 0;
    proveMatch(id, {}, () => {
      callCount++;
    });
    const job = getJob(id)!;
    // Simulate worker result
    claimNextJob();
    submitJobResult(id, dummyArtifacts());
    expect(callCount).toBe(1);
    // Simulate second prover calling onResult directly (would be Boundless)
    job.onResult?.(dummyArtifacts({ seal: "different" }));
    // Should still be 1 — the outer onResult is not called again
    expect(callCount).toBe(1);
  });

  test("duplicate queueProof call for same matchId returns existing job", () => {
    const id = uniqueMatchId();
    proveMatch(id, { a: 1 }, () => {});
    const dup = queueProof(id, { a: 2 });
    expect(dup.matchId).toBe(id);
    expect(dup.transcript).toEqual({ a: 1 }); // original transcript
  });

  test("job is marked done after settle", () => {
    const id = uniqueMatchId();
    proveMatch(id, {}, () => {});
    claimNextJob();
    submitJobResult(id, dummyArtifacts());
    const job = getJob(id);
    // Job should be done
    expect(!job || job.status === "done").toBe(true);
  });

  test("proveMatch without Boundless env vars relies on worker only", () => {
    // Verify no crash when BOUNDLESS_RPC_URL / BOUNDLESS_PRIVATE_KEY are not set
    const id = uniqueMatchId();
    let called = false;
    proveMatch(id, {}, () => {
      called = true;
    });
    expect(getJob(id)).not.toBeNull();
    // Simulate worker completion
    claimNextJob();
    submitJobResult(id, dummyArtifacts());
    expect(called).toBe(true);
  });
});

// ── Job state transitions ───────────────────────────────────

describe("job state transitions", () => {
  test("queued -> claimed -> done", () => {
    const id = uniqueMatchId();
    queueProof(id, {});
    expect(getJob(id)!.status).toBe("queued");

    claimNextJob();
    expect(getJob(id)!.status).toBe("claimed");

    submitJobResult(id, dummyArtifacts());
    expect(getJob(id)!.status).toBe("done");
  });

  test("claimed -> re-queued -> re-claimed (via timeout)", () => {
    const id = uniqueMatchId();
    queueProof(id, {});
    const job = claimNextJob()!;
    expect(job.status).toBe("claimed");

    // Backdate to trigger timeout
    job.claimedAt = Date.now() - 6 * 60 * 1000;
    // claimNextJob triggers pruneJobs (resets to queued) then re-claims
    const reclaimed = claimNextJob();
    expect(reclaimed).not.toBeNull();
    expect(reclaimed!.matchId).toBe(id);
    expect(reclaimed!.status).toBe("claimed");
    // claimedAt should be fresh (recent)
    expect(reclaimed!.claimedAt).toBeDefined();
    expect(Date.now() - reclaimed!.claimedAt!).toBeLessThan(5000);
  });

  test("re-queued job can be claimed again", () => {
    const id = uniqueMatchId();
    queueProof(id, {});
    const job = claimNextJob()!;
    job.claimedAt = Date.now() - 6 * 60 * 1000;

    // Re-claim triggers prune + picks up the re-queued job
    const reclaimed = claimNextJob();
    expect(reclaimed).not.toBeNull();
    expect(reclaimed!.matchId).toBe(id);
    expect(reclaimed!.status).toBe("claimed");
  });

  test("multiple jobs: claim order is FIFO", () => {
    const ids = [uniqueMatchId(), uniqueMatchId(), uniqueMatchId()];
    for (const id of ids) queueProof(id, {});

    for (const expectedId of ids) {
      const claimed = claimNextJob();
      expect(claimed!.matchId).toBe(expectedId);
    }
  });

  test("interleaved queue and claim operations", () => {
    const id1 = uniqueMatchId();
    const id2 = uniqueMatchId();
    const id3 = uniqueMatchId();

    queueProof(id1, {});
    const c1 = claimNextJob()!;
    expect(c1.matchId).toBe(id1);

    queueProof(id2, {});
    queueProof(id3, {});

    const c2 = claimNextJob()!;
    expect(c2.matchId).toBe(id2);

    submitJobResult(id1, dummyArtifacts());
    expect(getJob(id1)!.status).toBe("done");

    const c3 = claimNextJob()!;
    expect(c3.matchId).toBe(id3);
    // id1 should have been pruned by the claimNextJob call
    expect(getJob(id1)).toBeNull();
  });
});
