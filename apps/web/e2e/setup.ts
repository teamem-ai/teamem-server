import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const baseURL = process.env["E2E_BASE_URL"] ?? "http://localhost:8080";
const e2eSecret = process.env["TEAMEM_E2E_SECRET"];

interface E2eSetupResponse {
  ownerCookie: string;
  viewerCookie: string;
  teamId: string;
  projectId: string;
  projectName: string;
}

function cookieToStorageState(cookie: string) {
  const [name, value] = cookie.split("=");
  return {
    cookies: [
      {
        name: name!,
        value: value!,
        domain: "localhost",
        path: "/",
        expires: Math.floor(Date.now() / 1000) + 86400,
        httpOnly: true,
        secure: false,
        sameSite: "Lax" as const,
      },
    ],
    origins: [],
  };
}

export default async function globalSetup() {
  if (!e2eSecret) {
    console.log("TEAMEM_E2E_SECRET is not set; skipping E2E session setup.");
    return;
  }

  const res = await fetch(`${baseURL}/__e2e/setup`, {
    method: "POST",
    headers: { "X-E2E-Secret": e2eSecret },
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`E2E setup failed: ${res.status} ${body}`);
  }

  const data = (await res.json()) as E2eSetupResponse;

  await mkdir(join(__dirname, ".auth"), { recursive: true });
  await writeFile(
    join(__dirname, ".auth/owner.json"),
    JSON.stringify(cookieToStorageState(data.ownerCookie), null, 2),
  );
  await writeFile(
    join(__dirname, ".auth/viewer.json"),
    JSON.stringify(cookieToStorageState(data.viewerCookie), null, 2),
  );

  console.log("E2E sessions created: owner + viewer");
}
