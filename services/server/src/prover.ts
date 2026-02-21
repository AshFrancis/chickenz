import { spawn } from "child_process";
import { writeFile, readFile, unlink } from "fs/promises";
import { tmpdir } from "os";
import { join, resolve } from "path";
const PROVER_BINARY = process.env.PROVER_BINARY || resolve(import.meta.dir, "../../prover/target/release/chickenz-host");
const WORKER_TIMEOUT_MS = 60_000; // worker considered offline after 60s without poll

export interface ProofArtifacts {
  seal: string;    // hex-encoded
  journal: string; // hex-encoded
  imageId: string; // hex-encoded
}

export interface ProofJob {
  matchId: string;
  transcript: object;
  status: "queued" | "claimed" | "proving" | "done" | "failed";
  claimedAt?: number;
  artifacts?: ProofArtifacts;
  onResult?: (artifacts: ProofArtifacts | null) => void;
}

// ── Proof Queue ──────────────────────────────────────────

const proofQueue: ProofJob[] = [];
let lastWorkerPing = 0;
const JOB_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

export function isWorkerOnline(): boolean {
  return Date.now() - lastWorkerPing < WORKER_TIMEOUT_MS;
}

export function workerHeartbeat() {
  lastWorkerPing = Date.now();
}

/** Queue a proof job. Called when a ranked match ends. */
export function queueProof(matchId: string, transcript: object, onResult?: (artifacts: ProofArtifacts | null) => void): ProofJob {
  const job: ProofJob = { matchId, transcript, status: "queued", onResult };
  proofQueue.push(job);
  console.log(`[prover] Queued proof for ${matchId} (queue size: ${proofQueue.length})`);
  return job;
}

/** Get the next unclaimed job for a worker. */
export function claimNextJob(): ProofJob | null {
  workerHeartbeat();
  pruneJobs();
  const job = proofQueue.find((j) => j.status === "queued");
  if (job) {
    job.status = "claimed";
    job.claimedAt = Date.now();
    console.log(`[prover] Job ${job.matchId} claimed by worker`);
  }
  return job ?? null;
}

/** Get a job's transcript for the worker to download. */
export function getJobTranscript(matchId: string): object | null {
  const job = proofQueue.find((j) => j.matchId === matchId);
  return job?.transcript ?? null;
}

/** Worker submits proof result. */
export function submitJobResult(matchId: string, artifacts: ProofArtifacts): ProofJob | null {
  const job = proofQueue.find((j) => j.matchId === matchId);
  if (!job) return null;
  job.artifacts = artifacts;
  job.status = "done";
  console.log(`[prover] Proof received for ${matchId}`);
  // Invoke onResult callback if registered
  if (job.onResult) {
    try { job.onResult(artifacts); } catch (e) { console.error(`[prover] onResult callback error for ${matchId}:`, e); }
  }
  return job;
}

/** Prune completed/failed jobs older than 5 min, reset stale claimed jobs. */
function pruneJobs() {
  const now = Date.now();
  for (let i = proofQueue.length - 1; i >= 0; i--) {
    const job = proofQueue[i]!;
    // Remove completed/failed jobs older than 5 min
    if ((job.status === "done" || job.status === "failed") && job.claimedAt && now - job.claimedAt > JOB_TIMEOUT_MS) {
      proofQueue.splice(i, 1);
      continue;
    }
    // Reset claimed jobs stuck >5 min back to queued
    if (job.status === "claimed" && job.claimedAt && now - job.claimedAt > JOB_TIMEOUT_MS) {
      console.log(`[prover] Job ${job.matchId} timed out, re-queuing`);
      job.status = "queued";
      job.claimedAt = undefined;
    }
  }
}

/** Get a job by match ID. */
export function getJob(matchId: string): ProofJob | null {
  return proofQueue.find((j) => j.matchId === matchId) ?? null;
}

// ── Boundless fallback (spawns local binary) ─────────────

export async function proveBoundless(
  matchId: string,
  transcript: object,
): Promise<ProofArtifacts | null> {
  const inputPath = join(tmpdir(), `chickenz-prove-${matchId}.json`);

  try {
    await writeFile(inputPath, JSON.stringify(transcript));
    console.log(`[prover] Starting Boundless proof for ${matchId}...`);

    const result = await new Promise<number>((resolve, reject) => {
      const proc = spawn(PROVER_BINARY, ["--boundless", inputPath], {
        cwd: join(tmpdir()),
        env: {
          ...process.env,
          RPC_URL: process.env.BOUNDLESS_RPC_URL,
          PRIVATE_KEY: process.env.BOUNDLESS_PRIVATE_KEY,
          PINATA_JWT: process.env.PINATA_JWT,
        },
        stdio: ["ignore", "pipe", "pipe"],
      });

      let stdout = "";
      let stderr = "";
      proc.stdout.on("data", (data: Buffer) => { stdout += data.toString(); });
      proc.stderr.on("data", (data: Buffer) => { stderr += data.toString(); });
      proc.on("error", (err) => {
        console.error(`[prover] Failed to spawn Boundless for ${matchId}:`, err.message);
        reject(err);
      });
      proc.on("close", (code) => {
        if (code !== 0) {
          console.error(`[prover] Boundless exited with code ${code} for ${matchId}`);
          if (stderr) console.error(`[prover] stderr: ${stderr.slice(0, 500)}`);
          if (stdout) console.log(`[prover] stdout: ${stdout.slice(0, 500)}`);
        }
        resolve(code ?? 1);
      });
    });

    if (result !== 0) return null;

    const artifactsRaw = await readFile(join(tmpdir(), "proof_artifacts.json"), "utf-8");
    const artifacts = JSON.parse(artifactsRaw) as ProofArtifacts;
    console.log(`[prover] Boundless proof generated for ${matchId}`);
    return artifacts;
  } catch (err) {
    console.error(`[prover] Error in Boundless proving ${matchId}:`, err);
    return null;
  } finally {
    try { await unlink(inputPath); } catch {}
    try { await unlink(join(tmpdir(), "proof_artifacts.json")); } catch {}
  }
}

/**
 * Race proof request: always queue for worker AND submit to Boundless.
 * Whichever finishes first wins. The onResult callback fires exactly once.
 */
export function proveMatch(
  matchId: string,
  transcript: object,
  onResult: (artifacts: ProofArtifacts | null) => void,
) {
  let settled = false;
  const settleOnce = (source: string) => (artifacts: ProofArtifacts | null) => {
    if (settled) return;
    if (!artifacts) {
      // Only settle with null if both have failed — track individually
      return;
    }
    settled = true;
    console.log(`[prover] ${matchId} proved by ${source}`);
    onResult(artifacts);
  };

  // Always queue for worker (gaming PC polls these)
  queueProof(matchId, transcript, settleOnce("worker"));
  console.log(`[prover] Queued ${matchId} for worker`);

  // Also submit to Boundless in parallel
  if (process.env.BOUNDLESS_RPC_URL && process.env.BOUNDLESS_PRIVATE_KEY) {
    console.log(`[prover] Submitting ${matchId} to Boundless in parallel`);
    proveBoundless(matchId, transcript)
      .then((artifacts) => {
        if (artifacts) {
          settleOnce("boundless")(artifacts);
        } else {
          console.log(`[prover] Boundless failed for ${matchId}`);
          // If worker hasn't delivered either, give up
          if (!settled) {
            const job = proofQueue.find((j) => j.matchId === matchId);
            if (!job || job.status === "failed") {
              settled = true;
              onResult(null);
            }
          }
        }
      })
      .catch(() => {
        console.log(`[prover] Boundless error for ${matchId}`);
        if (!settled) {
          const job = proofQueue.find((j) => j.matchId === matchId);
          if (!job || job.status === "failed") {
            settled = true;
            onResult(null);
          }
        }
      });
  } else {
    console.log(`[prover] No Boundless config — ${matchId} relies on worker only`);
  }
}
