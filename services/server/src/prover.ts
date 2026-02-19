import { spawn } from "child_process";
import { writeFile, readFile, unlink } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";

const PROVER_BINARY = process.env.PROVER_BINARY || "../prover/target/release/chickenz-host";

export interface ProofArtifacts {
  seal: string;    // hex-encoded
  journal: string; // hex-encoded
  imageId: string; // hex-encoded
}

/**
 * Spawn the Boundless prover binary to generate a ZK proof for a match.
 * Returns proof artifacts on success, null on failure.
 * This is async and may take 5-30 minutes.
 */
export async function proveMatch(
  matchId: string,
  transcript: object,
): Promise<ProofArtifacts | null> {
  const inputPath = join(tmpdir(), `chickenz-prove-${matchId}.json`);
  const outputPath = join(tmpdir(), `chickenz-proof-${matchId}.json`);

  try {
    // Write transcript to temp file
    await writeFile(inputPath, JSON.stringify(transcript));

    console.log(`[prover] Starting proof for ${matchId}...`);

    // Spawn prover binary
    const result = await new Promise<number>((resolve, reject) => {
      const proc = spawn(PROVER_BINARY, ["--boundless", "--input", inputPath, "--output", outputPath], {
        env: {
          ...process.env,
          // Pass through Boundless env vars
          BOUNDLESS_RPC_URL: process.env.BOUNDLESS_RPC_URL,
          BOUNDLESS_PRIVATE_KEY: process.env.BOUNDLESS_PRIVATE_KEY,
          PINATA_JWT: process.env.PINATA_JWT,
        },
        stdio: ["ignore", "pipe", "pipe"],
      });

      let stdout = "";
      let stderr = "";

      proc.stdout.on("data", (data: Buffer) => {
        stdout += data.toString();
      });

      proc.stderr.on("data", (data: Buffer) => {
        stderr += data.toString();
      });

      proc.on("error", (err) => {
        console.error(`[prover] Failed to spawn prover for ${matchId}:`, err.message);
        reject(err);
      });

      proc.on("close", (code) => {
        if (code !== 0) {
          console.error(`[prover] Prover exited with code ${code} for ${matchId}`);
          if (stderr) console.error(`[prover] stderr: ${stderr.slice(0, 500)}`);
          if (stdout) console.log(`[prover] stdout: ${stdout.slice(0, 500)}`);
        }
        resolve(code ?? 1);
      });
    });

    if (result !== 0) {
      return null;
    }

    // Read proof artifacts
    const artifactsRaw = await readFile(outputPath, "utf-8");
    const artifacts = JSON.parse(artifactsRaw) as ProofArtifacts;
    console.log(`[prover] Proof generated for ${matchId}`);
    return artifacts;
  } catch (err) {
    console.error(`[prover] Error proving ${matchId}:`, err);
    return null;
  } finally {
    // Clean up temp files
    try { await unlink(inputPath); } catch {}
    try { await unlink(outputPath); } catch {}
  }
}
