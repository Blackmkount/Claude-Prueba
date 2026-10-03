// Certificados del simulador: una CA propia y un certificado por impresora con
// CN = número de serie, igual que las A1 reales (firmadas por la CA de Bambu).
// Así el módulo de impresora verifica TLS contra el simulador exactamente como
// lo hará contra una impresora real.
import "reflect-metadata";
import * as x509 from "@peculiar/x509";
import { webcrypto } from "node:crypto";

type CryptoKeyPair = webcrypto.CryptoKeyPair;
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

x509.cryptoProvider.set(webcrypto as never);

const ALG = {
  name: "RSASSA-PKCS1-v1_5",
  hash: "SHA-256",
  publicExponent: new Uint8Array([1, 0, 1]),
  modulusLength: 2048,
} as const;

export interface KeyPairPem {
  certPem: string;
  keyPem: string;
}

export interface SimulatorCa extends KeyPairPem {
  keys: CryptoKeyPair;
  cert: x509.X509Certificate;
}

function toPem(der: ArrayBuffer, label: string): string {
  const b64 = Buffer.from(der)
    .toString("base64")
    .replace(/(.{64})/g, "$1\n");
  return `-----BEGIN ${label}-----\n${b64}\n-----END ${label}-----\n`;
}

function serialHex(): string {
  return Buffer.from(webcrypto.getRandomValues(new Uint8Array(8))).toString("hex");
}

export async function createCa(): Promise<SimulatorCa> {
  const keys = (await webcrypto.subtle.generateKey(ALG, true, ["sign", "verify"])) as CryptoKeyPair;
  const cert = await x509.X509CertificateGenerator.createSelfSigned({
    serialNumber: serialHex(),
    name: "C=CO, O=BlackForge Simulador, CN=BlackForge Sim CA",
    notBefore: new Date(Date.now() - 86_400_000),
    notAfter: new Date(Date.now() + 10 * 365 * 86_400_000),
    keys,
    signingAlgorithm: ALG,
    extensions: [
      new x509.BasicConstraintsExtension(true, undefined, true),
      new x509.KeyUsagesExtension(
        x509.KeyUsageFlags.keyCertSign | x509.KeyUsageFlags.cRLSign,
        true,
      ),
    ],
  });
  const keyDer = await webcrypto.subtle.exportKey("pkcs8", keys.privateKey);
  return { keys, cert, certPem: cert.toString("pem") + "\n", keyPem: toPem(keyDer, "PRIVATE KEY") };
}

export async function createPrinterCert(ca: SimulatorCa, serial: string): Promise<KeyPairPem> {
  const keys = (await webcrypto.subtle.generateKey(ALG, true, ["sign", "verify"])) as CryptoKeyPair;
  const cert = await x509.X509CertificateGenerator.create({
    serialNumber: serialHex(),
    subject: `CN=${serial}`,
    issuer: ca.cert.subject,
    notBefore: new Date(Date.now() - 86_400_000),
    notAfter: new Date(Date.now() + 10 * 365 * 86_400_000),
    signingKey: ca.keys.privateKey,
    publicKey: keys.publicKey,
    signingAlgorithm: ALG,
    extensions: [new x509.BasicConstraintsExtension(false, undefined, true)],
  });
  const keyDer = await webcrypto.subtle.exportKey("pkcs8", keys.privateKey);
  return { certPem: cert.toString("pem") + "\n", keyPem: toPem(keyDer, "PRIVATE KEY") };
}

/**
 * CA persistente en un directorio (para que el CLI y la app confíen en ella
 * entre reinicios del simulador). Si no existe, la crea.
 */
export async function loadOrCreateCa(dir: string): Promise<SimulatorCa> {
  const certPath = join(dir, "ca.pem");
  const keyPath = join(dir, "ca-key.pem");
  try {
    const [certPem, keyPem] = await Promise.all([
      readFile(certPath, "utf8"),
      readFile(keyPath, "utf8"),
    ]);
    const cert = new x509.X509Certificate(certPem);
    const keyDer = Buffer.from(
      keyPem.replace(/-----[^-]+-----/g, "").replace(/\s+/g, ""),
      "base64",
    );
    const privateKey = await webcrypto.subtle.importKey("pkcs8", keyDer, ALG, true, ["sign"]);
    const publicKey = (await cert.publicKey.export(
      ALG,
      ["verify"],
      webcrypto as never,
    )) as unknown as webcrypto.CryptoKey;
    return { cert, certPem, keyPem, keys: { privateKey, publicKey } };
  } catch {
    const ca = await createCa();
    await mkdir(dir, { recursive: true });
    await writeFile(certPath, ca.certPem);
    await writeFile(keyPath, ca.keyPem, { mode: 0o600 });
    return ca;
  }
}
