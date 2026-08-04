// Shared IP-allowlist parsing + matching for the crew floor-login gate. Lives in
// contracts so the enforcer (crew-web BFF), the validator (backoffice settings UI),
// and the store (inventory-api) all agree on the format. Pure, dependency-free.
//
// Format: a free-text field of single IPs and/or CIDR ranges, separated by commas
// or newlines. IPv4 supports CIDR (a.b.c.d/n); IPv6 is matched only as an exact,
// normalized string (a single store rarely needs IPv6 CIDR, and getting v6 CIDR
// right without a dep is error-prone). An EMPTY list means "allow all" — the gate
// is opt-in, so a blank setting never locks the floor out.

export function parseIpAllowlist(raw: string): string[] {
  return raw
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function parseIpv4(ip: string): number | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const n = Number(part);
    if (n > 255) return null;
    value = value * 256 + n;
  }
  // >>> 0 keeps it an unsigned 32-bit int.
  return value >>> 0;
}

function isIpv6(ip: string): boolean {
  // Loose check — enough to accept a normalized v6 literal for exact matching.
  return ip.includes(":") && /^[0-9a-fA-F:]+$/.test(ip);
}

// Is `entry` a syntactically valid allowlist entry (single IPv4/IPv6 or IPv4 CIDR)?
export function isValidIpAllowlistEntry(entry: string): boolean {
  const slash = entry.indexOf("/");
  if (slash === -1) {
    return parseIpv4(entry) !== null || isIpv6(entry);
  }
  const ip = entry.slice(0, slash);
  const bitsRaw = entry.slice(slash + 1);
  if (!/^\d{1,2}$/.test(bitsRaw)) return false;
  const bits = Number(bitsRaw);
  // Only IPv4 CIDR is supported.
  return parseIpv4(ip) !== null && bits >= 0 && bits <= 32;
}

// Validate the whole field (every entry well-formed). Empty is valid (allow-all).
export function isValidIpAllowlist(raw: string): boolean {
  return parseIpAllowlist(raw).every(isValidIpAllowlistEntry);
}

function ipv4InCidr(ip: number, cidrIp: number, bits: number): boolean {
  if (bits === 0) return true; // 0.0.0.0/0 matches everything
  const mask = (0xffffffff << (32 - bits)) >>> 0;
  return (ip & mask) === (cidrIp & mask);
}

// Does `clientIp` match any entry? Callers treat an empty `entries` as allow-all
// BEFORE calling (so a blank setting is a no-op gate). Unparseable client IPs and
// unparseable entries never match (fail closed on the entry, open on empty list).
export function ipMatchesAllowlist(clientIp: string, entries: string[]): boolean {
  const ip = clientIp.trim();
  const v4 = parseIpv4(ip);
  for (const entry of entries) {
    const slash = entry.indexOf("/");
    if (slash === -1) {
      if (v4 !== null && parseIpv4(entry) === v4) return true;
      if (v4 === null && entry === ip) return true; // exact (incl. IPv6)
      continue;
    }
    if (v4 === null) continue; // CIDR entries are IPv4-only
    const cidrIp = parseIpv4(entry.slice(0, slash));
    const bits = Number(entry.slice(slash + 1));
    if (cidrIp !== null && ipv4InCidr(v4, cidrIp, bits)) return true;
  }
  return false;
}
