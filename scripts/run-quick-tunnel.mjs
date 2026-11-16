import { spawn } from "node:child_process";
import Database from "better-sqlite3";

const database = new Database(".data/lostfound.sqlite", { readonly: true });
const columns = database.pragma("table_info(admin)");
const admin = columns.some(({ name }) => name === "password_changed_at")
  ? database.prepare("SELECT password_changed_at FROM admin WHERE id = 1").get()
  : null;
database.close();

if (!admin?.password_changed_at) {
  console.error("Quick Tunnel is blocked. Log in to the local admin page and change the administrator password to a new password with at least 16 characters first.");
  process.exit(1);
}

const tunnel = spawn("cloudflared", ["tunnel", "--url", "http://127.0.0.1:3001"], {
  stdio: "inherit",
});

tunnel.on("error", (error) => {
  console.error(`Could not start Cloudflare Tunnel: ${error.message}`);
  process.exitCode = 1;
});
tunnel.on("exit", (code, signal) => {
  process.exitCode = code ?? (signal ? 1 : 0);
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => tunnel.kill(signal));
}
