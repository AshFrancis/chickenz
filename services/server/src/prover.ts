import { spawn } from "child_process";
import { writeFile, readFile, unlink } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";

const PROVER_BINARY = process.env.PROVER_BINARY || "../prover/target/release/chickenz-host";
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
}

// ── Proof Queue ──────────────────────────────────────────

const proofQueue: ProofJob[] = [];
let lastWorkerPing = 0;

export function isWorkerOnline(): boolean {
  return Date.now() - lastWorkerPing < WORKER_TIMEOUT_MS;
}

export function workerHeartbeat() {
  lastWorkerPing = Date.now();
}

/** Queue a proof job. Called when a ranked match ends. */
export function queueProof(matchId: string, transcript: object): ProofJob {
  const job: ProofJob = { matchId, transcript, status: "queued" };
  proofQueue.push(job);
  console.log(`[prover] Queued proof for ${matchId} (queue size: ${proofQueue.length})`);
  return job;
}

/** Get the next unclaimed job for a worker. */
export function claimNextJob(): ProofJob | null {
  workerHeartbeat();
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
  return job;
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
  const outputPath = join(tmpdir(), `chickenz-proof-${matchId}.json`);

  try {
    await writeFile(inputPath, JSON.stringify(transcript));
    console.log(`[prover] Starting Boundless proof for ${matchId}...`);

    const result = await new Promise<number>((resolve, reject) => {
      const proc = spawn(PROVER_BINARY, ["--boundless", "--input", inputPath, "--output", outputPath], {
        env: {
          ...process.env,
          BOUNDLESS_RPC_URL: process.env.BOUNDLESS_RPC_URL,
          BOUNDLESS_PRIVATE_KEY: process.env.BOUNDLESS_PRIVATE_KEY,
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

    const artifactsRaw = await readFile(outputPath, "utf-8");
    const artifacts = JSON.parse(artifactsRaw) as ProofArtifacts;
    console.log(`[prover] Boundless proof generated for ${matchId}`);
    return artifacts;
  } catch (err) {
    console.error(`[prover] Error in Boundless proving ${matchId}:`, err);
    return null;
  } finally {
    try { await unlink(inputPath); } catch {}
    try { await unlink(outputPath); } catch {}
  }
}

/**
 * Route a proof request: local worker if online, else Boundless.
 * Returns a function that resolves when proof is ready (for Boundless),
 * or null if queued for worker (caller polls via getJob).
 */
export function proveMatch(
  matchId: string,
  transcript: object,
  onResult: (artifacts: ProofArtifacts | null) => void,
) {
  if (isWorkerOnline()) {
    // Queue for local worker — it'll poll and pick it up
    queueProof(matchId, transcript);
    console.log(`[prover] Routed ${matchId} to local worker`);
    // The caller will be notified when worker submits result
  } else if (process.env.BOUNDLESS_RPC_URL && process.env.BOUNDLESS_PRIVATE_KEY) {
    // Fall back to Boundless
    console.log(`[prover] Worker offline, routing ${matchId} to Boundless`);
    proveBoundless(matchId, transcript).then(onResult).catch(() => onResult(null));
  } else {
    console.log(`[prover] No worker online and no Boundless config — skipping proof for ${matchId}`);
    onResult(null);
  }
}
