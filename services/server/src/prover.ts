import { spawn } from "child_process";
import { writeFile, readFile, unlink, mkdir, rmdir } from "fs/promises";
import { tmpdir } from "os";
import { join, resolve } from "path";
import { createLogger } from "./logger";

const log = createLogger("prover");
const PROVER_BINARY =
  process.env.PROVER_BINARY || resolve(import.meta.dir, "../../prover/target/release/chickenz-host");
const WORKER_TIMEOUT_MS = 60_000; // worker considered offline after 60s without poll

export interface ProofArtifacts {
  seal: string; // hex-encoded
  journal: string; // hex-encoded
  imageId: string; // hex-encoded
  boundlessRequestId?: string; // Boundless marketplace request ID (hex)
}

export interface ProofJob {
  matchId: string;
  transcript: object;
  status: "queued" | "claimed" | "done";
  claimedAt?: number;
  artifacts?: ProofArtifacts;
  onResult?: (artifacts: ProofArtifacts | null, source?: string) => void;
}

// ── Proof Queue ──────────────────────────────────────────

const proofQueue: ProofJob[] = [];
const MAX_QUEUE_SIZE = 50; // prevent unbounded memory growth
let lastWorkerPing = 0;
const JOB_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

export function isWorkerOnline(): boolean {
  return Date.now() - lastWorkerPing < WORKER_TIMEOUT_MS;
}

export function getPendingProofCount(): number {
  return proofQueue.filter((j) => j.status !== "done").length;
}

export function workerHeartbeat() {
  lastWorkerPing = Date.now();
}

/** Queue a proof job. Called when a ranked match ends. Deduplicates by matchId. */
export function queueProof(
  matchId: string,
  transcript: object,
  onResult?: (artifacts: ProofArtifacts | null, source?: string) => void,
): ProofJob {
  // Prevent duplicate queue entries for the same match
  const existing = proofQueue.find((j) => j.matchId === matchId);
  if (existing) {
    log.info("Job already in queue, skipping", { matchId, status: existing.status });
    return existing;
  }
  // Enforce max queue size — evict oldest done/queued jobs
  while (proofQueue.length >= MAX_QUEUE_SIZE) {
    const doneIdx = proofQueue.findIndex((j) => j.status === "done");
    if (doneIdx >= 0) {
      proofQueue.splice(doneIdx, 1);
    } else {
      // Drop oldest queued job
      const queuedIdx = proofQueue.findIndex((j) => j.status === "queued");
      if (queuedIdx >= 0) {
        log.warn("Queue full, dropping oldest job", { matchId: proofQueue[queuedIdx]!.matchId });
        proofQueue.splice(queuedIdx, 1);
      } else {
        break; // All jobs are claimed — can't evict
      }
    }
  }
  const job: ProofJob = { matchId, transcript, status: "queued", onResult };
  proofQueue.push(job);
  log.info("Queued proof", { matchId, queueSize: proofQueue.length });
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
    log.info("Job claimed by worker", { matchId: job.matchId });
  }
  return job ?? null;
}

/** Get a job's transcript for the worker to download (only if claimed). */
export function getJobTranscript(matchId: string): object | null {
  const job = proofQueue.find((j) => j.matchId === matchId && j.status === "claimed");
  return job?.transcript ?? null;
}

/** Worker submits proof result (only for claimed jobs). */
export function submitJobResult(matchId: string, artifacts: ProofArtifacts): ProofJob | null {
  const job = proofQueue.find((j) => j.matchId === matchId && j.status === "claimed");
  if (!job) return null;
  job.artifacts = artifacts;
  job.status = "done";
  log.info("Proof received", { matchId });
  // Invoke onResult callback if registered
  if (job.onResult) {
    try {
      job.onResult(artifacts, "worker");
    } catch (e) {
      log.error("onResult callback error", { matchId, error: (e as Error).message });
    }
  }
  return job;
}

/** Prune completed jobs, reset stale claimed jobs. */
function pruneJobs() {
  const now = Date.now();
  for (let i = proofQueue.length - 1; i >= 0; i--) {
    const job = proofQueue[i]!;
    // Remove completed jobs (result already delivered via callback)
    if (job.status === "done") {
      proofQueue.splice(i, 1);
      continue;
    }
    // Reset claimed jobs stuck >5 min back to queued
    if (job.status === "claimed" && job.claimedAt && now - job.claimedAt > JOB_TIMEOUT_MS) {
      log.warn("Job timed out, re-queuing", { matchId: job.matchId });
      job.status = "queued";
      job.claimedAt = undefined;
    }
  }
}

/** Get a job by match ID. */
export function getJob(matchId: string): ProofJob | null {
  return proofQueue.find((j) => j.matchId === matchId) ?? null;
}

/** Reset all state for testing. Not for production use. */
export function _resetForTesting() {
  proofQueue.length = 0;
  lastWorkerPing = 0;
}

// ── Boundless fallback (spawns local binary) ─────────────

export async function proveBoundless(
  matchId: string,
  transcript: object,
  onRequestId?: (requestId: string) => void,
  onTxHash?: (txHash: string) => void,
): Promise<ProofArtifacts | null> {
  const workDir = join(tmpdir(), `chickenz-prove-${matchId}`);
  const inputPath = join(workDir, "input.json");
  const outputPath = join(workDir, "proof_artifacts.json");

  try {
    await mkdir(workDir, { recursive: true });
    await writeFile(inputPath, JSON.stringify(transcript));
    log.info("Starting Boundless proof", { matchId });

    let stdout = "";
    let stderr = "";
    let capturedRequestId: string | undefined;
    let capturedTxHash: string | undefined;
    const result = await new Promise<number>((resolve, reject) => {
      const proc = spawn(PROVER_BINARY, ["--boundless", inputPath], {
        cwd: workDir,
        env: {
          ...process.env,
          RPC_URL: process.env.BOUNDLESS_RPC_URL,
          PRIVATE_KEY: process.env.BOUNDLESS_PRIVATE_KEY,
          PINATA_JWT: process.env.PINATA_JWT,
        },
        stdio: ["ignore", "pipe", "pipe"],
      });

      proc.stdout.on("data", (data: Buffer) => {
        stdout += data.toString();
      });
      proc.stderr.on("data", (data: Buffer) => {
        const chunk = data.toString();
        stderr += chunk;
        // Capture Boundless request ID as soon as it's printed (before proof completes)
        if (!capturedRequestId) {
          const reqIdMatch = chunk.match(/Request ID:\s*([0-9a-fA-Fx]+)/);
          if (reqIdMatch) {
            capturedRequestId = reqIdMatch[1]!;
            log.info("Boundless request ID", { matchId, requestId: capturedRequestId });
            onRequestId?.(capturedRequestId);
          }
        }
        // Capture tx hash from Boundless SDK tracing output: "Broadcasting tx <hash> with request ID"
        if (!capturedTxHash) {
          const txMatch = chunk.match(/Broadcasting tx (0x)?([0-9a-fA-F]{64})/);
          if (txMatch) {
            capturedTxHash = `0x${txMatch[2]!}`;
            log.info("Boundless tx hash", { matchId, txHash: capturedTxHash });
            onTxHash?.(capturedTxHash);
          }
        }
      });
      proc.on("error", (err) => {
        log.error("Failed to spawn Boundless", { matchId, error: err.message });
        reject(err);
      });
      proc.on("close", (code) => {
        if (code !== 0) {
          log.error("Boundless exited with non-zero code", { matchId, exitCode: code });
          if (stderr) log.error("Boundless stderr", { matchId, stderr: stderr.slice(-4000) });
          if (stdout) log.info("Boundless stdout", { matchId, stdout: stdout.slice(-4000) });
        }
        resolve(code ?? 1);
      });
    });

    if (result !== 0) return null;

    const artifactsRaw = await readFile(outputPath, "utf-8");
    const artifacts = JSON.parse(artifactsRaw) as ProofArtifacts;

    if (capturedRequestId) {
      artifacts.boundlessRequestId = capturedRequestId;
    }

    log.info("Boundless proof generated", { matchId });
    return artifacts;
  } catch (err) {
    log.error("Error in Boundless proving", { matchId, error: (err as Error).message });
    return null;
  } finally {
    try {
      await unlink(inputPath);
    } catch {
      /* cleanup */
    }
    try {
      await unlink(outputPath);
    } catch {
      /* cleanup */
    }
    try {
      await rmdir(workDir);
    } catch {
      /* cleanup */
    }
  }
}

/**
 * Race proof request: always queue for worker AND submit to Boundless.
 * Whichever finishes first wins. The onResult callback fires exactly once.
 */
export function proveMatch(
  matchId: string,
  transcript: object,
  onResult: (artifacts: ProofArtifacts | null, source?: string) => void,
  onBoundlessRequestId?: (requestId: string) => void,
  onBoundlessTxHash?: (txHash: string) => void,
) {
  let settled = false;
  let winnerSource: string | undefined;
  let winnerArtifacts: ProofArtifacts | undefined;

  function markJobDone() {
    const job = proofQueue.find((j) => j.matchId === matchId);
    if (job && job.status !== "done") {
      job.status = "done";
    }
  }

  // eslint-disable-next-line prefer-const
  let safetyTimer: ReturnType<typeof setTimeout>;

  const settleOnce = (source: string) => (artifacts: ProofArtifacts | null, _source?: string) => {
    if (!artifacts) return;
    if (settled) {
      // Second prover finished — log comparison with the winner
      log.info("Also proved by runner-up", {
        matchId,
        source,
        winner: winnerSource,
        sealBytes: artifacts.seal.length / 2,
      });
      if (winnerArtifacts) {
        const journalMatch = artifacts.journal === winnerArtifacts.journal;
        if (journalMatch) {
          log.info("Runner-up journal matches winner", { matchId, source });
        } else {
          log.error("Journal MISMATCH between provers", {
            matchId,
            source,
            sourceJournal: artifacts.journal,
            winnerSource,
            winnerJournal: winnerArtifacts.journal,
          });
        }
      }
      return;
    }
    clearTimeout(safetyTimer); // Release closure references held by the safety timeout
    settled = true; // Set BEFORE calling onResult to prevent double-fire if onResult throws
    winnerSource = source;
    winnerArtifacts = artifacts;
    markJobDone(); // Prevent workers from re-claiming
    log.info("Match proved", { matchId, source });
    try {
      onResult(artifacts, source);
    } catch (err) {
      log.error("onResult threw", { matchId, error: (err as Error).message });
    }
  };

  // Safety timeout: if neither prover settles within 20 minutes, report failure
  // (Boundless marketplace queue can take 10-15 min on testnet)
  safetyTimer = setTimeout(
    () => {
      if (!settled) {
        settled = true;
        markJobDone(); // Clean up stale job
        log.warn("Match timed out after 20 minutes", { matchId });
        onResult(null);
      }
    },
    20 * 60 * 1000,
  );

  // Always queue for worker (gaming PC polls these)
  queueProof(matchId, transcript, settleOnce("worker"));
  log.info("Queued for worker", { matchId });

  // Also submit to Boundless in parallel
  if (process.env.BOUNDLESS_RPC_URL && process.env.BOUNDLESS_PRIVATE_KEY) {
    log.info("Submitting to Boundless in parallel", { matchId });
    proveBoundless(matchId, transcript, onBoundlessRequestId, onBoundlessTxHash)
      .then((artifacts) => {
        if (artifacts) {
          settleOnce("boundless")(artifacts);
        } else {
          log.warn("Boundless failed", { matchId });
          // If worker job is also gone (pruned/not claimed), give up
          if (!settled && !proofQueue.find((j) => j.matchId === matchId && j.status !== "done")) {
            settled = true;
            onResult(null);
          }
        }
      })
      .catch(() => {
        log.warn("Boundless error", { matchId });
        if (!settled && !proofQueue.find((j) => j.matchId === matchId && j.status !== "done")) {
          settled = true;
          onResult(null);
        }
      });
  } else {
    log.info("No Boundless config, relies on worker only", { matchId });
  }
}
