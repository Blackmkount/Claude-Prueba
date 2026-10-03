// TLS hacia la impresora: opciones verificadas (CA de Bambu + servername = serie)
// y una sonda que lee el certificado para descubrir la serie y diagnosticar.
import { X509Certificate } from "node:crypto";
import tls from "node:tls";
import { BAMBU_CA_PEM } from "./bambu-ca.js";
import { fromNetworkError, PrinterError } from "./errors.js";

export interface TlsSettings {
  /** Verificar el certificado (cadena + número de serie). Recomendado: true. */
  verify: boolean;
  /** CA adicional en PEM (solo para el simulador). Si se da, reemplaza a la de Bambu. */
  caPem?: string;
}

export const DEFAULT_TLS: TlsSettings = { verify: true };

export function caBundle(settings: TlsSettings): string {
  return settings.caPem ?? BAMBU_CA_PEM;
}

/** Opciones para tls.connect / mqtt.js / basic-ftp. */
export function tlsOptionsFor(serial: string, settings: TlsSettings): tls.ConnectionOptions {
  return {
    ca: caBundle(settings),
    servername: serial,
    rejectUnauthorized: settings.verify,
    // Los brokers de Bambu medidos hablan TLS 1.2 y rechazan 1.3.
    minVersion: "TLSv1.2",
    maxVersion: "TLSv1.2",
  };
}

export function splitPemBundle(pem: string): X509Certificate[] {
  const blocks = pem.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g) ?? [];
  return blocks.map((b) => new X509Certificate(b));
}

function commonName(subject: string): string | undefined {
  // `subject` de X509Certificate viene como líneas "CN=...", "O=...".
  const line = subject.split("\n").find((l) => l.startsWith("CN="));
  return line?.slice(3).trim() || undefined;
}

export interface CertificateProbe {
  /** CN del certificado de la impresora = número de serie. */
  serial?: string;
  subject: string;
  issuer: string;
  validFrom: string;
  validTo: string;
  fingerprint256: string;
  /** La cadena termina en una CA de confianza (Bambu o la del simulador). */
  trusted: boolean;
  /** Por qué no se confía, si aplica. */
  trustError?: string;
  protocol: string | null;
  cipher?: string;
}

/**
 * Se conecta sin verificar, lee el certificado y comprueba a mano si lo firmó
 * una CA de confianza. Sirve para descubrir la serie y para el diagnóstico.
 */
export async function probeCertificate(
  host: string,
  port: number,
  options: { timeoutMs?: number; settings?: TlsSettings } = {},
): Promise<CertificateProbe> {
  const timeoutMs = options.timeoutMs ?? 8000;
  const trustedCas = splitPemBundle(caBundle(options.settings ?? DEFAULT_TLS));
  const socket = await new Promise<tls.TLSSocket>((resolve, reject) => {
    const s = tls.connect({
      host,
      port,
      rejectUnauthorized: false,
      minVersion: "TLSv1.2",
      maxVersion: "TLSv1.2",
      timeout: timeoutMs,
    });
    s.once("secureConnect", () => resolve(s));
    s.once("timeout", () => {
      s.destroy();
      reject(
        new PrinterError("timeout", `TLS ${host}:${port}: la impresora no respondió a tiempo.`),
      );
    });
    s.once("error", (err) => reject(fromNetworkError(err, `TLS ${host}:${port}`)));
  });
  try {
    const leaf = socket.getPeerX509Certificate();
    if (!leaf) throw new PrinterError("unknown", "La impresora no presentó certificado TLS.");
    // Cadena enviada por la impresora (si incluye intermedios).
    const chain: X509Certificate[] = [leaf];
    let peer = socket.getPeerCertificate(true) as tls.DetailedPeerCertificate;
    const seen = new Set<string>([peer.fingerprint256]);
    while (peer.issuerCertificate && !seen.has(peer.issuerCertificate.fingerprint256)) {
      peer = peer.issuerCertificate;
      seen.add(peer.fingerprint256);
      chain.push(new X509Certificate(peer.raw));
    }
    const { trusted, trustError } = verifyChain(chain, trustedCas);
    return {
      serial: commonName(leaf.subject),
      subject: leaf.subject.replace(/\n/g, ", "),
      issuer: leaf.issuer.replace(/\n/g, ", "),
      validFrom: leaf.validFrom,
      validTo: leaf.validTo,
      fingerprint256: leaf.fingerprint256,
      trusted,
      trustError,
      protocol: socket.getProtocol(),
      cipher: socket.getCipher()?.name,
    };
  } finally {
    socket.destroy();
  }
}

function verifyChain(
  chain: X509Certificate[],
  trustedCas: X509Certificate[],
): { trusted: boolean; trustError?: string } {
  for (let i = 0; i < chain.length; i++) {
    const cert = chain[i]!;
    const anchor = trustedCas.find((ca) => cert.checkIssued(ca) && cert.verify(ca.publicKey));
    if (anchor) {
      // Todos los eslabones anteriores deben estar firmados por el siguiente.
      for (let j = 0; j < i; j++) {
        const child = chain[j]!;
        const parent = chain[j + 1]!;
        if (!(child.checkIssued(parent) && child.verify(parent.publicKey))) {
          return { trusted: false, trustError: "La cadena de certificados está rota." };
        }
      }
      return { trusted: true };
    }
  }
  return {
    trusted: false,
    trustError: `Emisor no reconocido: ${chain[chain.length - 1]?.issuer.replace(/\n/g, ", ")}`,
  };
}
