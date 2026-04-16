import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Test vectors ────────────────────────────────────────────────────────────

// secp256k1 curve order and half order
const SECP256K1_ORDER = BigInt(
  "0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141",
);
const SECP256K1_HALF_ORDER = SECP256K1_ORDER / BigInt(2);

// Real DER-encoded ECDSA signature from a secp256k1 key (generated via Node.js crypto)
// Structure: 0x30 <totalLen> 0x02 <rLen> <rBytes> 0x02 <sLen> <sBytes>
const KNOWN_DER = new Uint8Array([
  0x30, 0x45, 0x02, 0x20,
  // r: 32 bytes (no leading zero — positive high bit not set)
  0x28, 0xcc, 0xef, 0x86, 0x79, 0x09, 0xab, 0x37,
  0x84, 0x19, 0x40, 0x20, 0x33, 0x4a, 0xc7, 0x12,
  0x2b, 0x95, 0x38, 0xa8, 0xcd, 0x5b, 0x7b, 0x0b,
  0x01, 0x7a, 0x39, 0x48, 0x2d, 0x27, 0x66, 0xc7,
  0x02, 0x21, 0x00,
  // s: 33 bytes (leading 0x00 because high bit is set — ASN.1 positive sign)
  0xd4, 0x88, 0xa7, 0x2d, 0xad, 0xcc, 0x1d, 0x3b,
  0x28, 0x47, 0xcc, 0x80, 0xa9, 0x67, 0x7b, 0x33,
  0x6a, 0x00, 0x5f, 0x2d, 0xbb, 0x08, 0xd9, 0x72,
  0x58, 0x4f, 0xb0, 0xdd, 0xa5, 0x00, 0x8a, 0x61,
]);

const EXPECTED_R = BigInt(
  "0x28ccef867909ab3784194020334ac7122b9538a8cd5b7b0b017a39482d2766c7",
);
const EXPECTED_S = BigInt(
  "0xd488a72dadcc1d3b2847cc80a9677b336a005f2dbb08d972584fb0dda5008a61",
);

// DER with leading-zero-padded r (33 bytes for r, demonstrating ASN.1 padding)
const DER_WITH_PADDED_R = new Uint8Array([
  0x30, 0x46, 0x02, 0x21, 0x00,
  // r: 33 bytes (leading 0x00 because first byte >= 0x80)
  0xf6, 0xbe, 0x38, 0x9f, 0x44, 0x2a, 0x70, 0x9c,
  0x76, 0x5e, 0xa0, 0x79, 0x86, 0xcf, 0x62, 0x8e,
  0xc6, 0x06, 0x19, 0xb3, 0x63, 0xb5, 0xbf, 0x6d,
  0xe5, 0x42, 0x8f, 0x4a, 0x18, 0x24, 0x19, 0xaf,
  0x02, 0x21, 0x00,
  // s: 33 bytes (leading 0x00)
  0xda, 0xf4, 0x5e, 0x44, 0x48, 0xe5, 0x19, 0xc7,
  0xba, 0x56, 0x1e, 0x44, 0xb1, 0x42, 0x66, 0x09,
  0xe5, 0x20, 0xdd, 0x6c, 0x55, 0x8d, 0xcf, 0x7d,
  0xac, 0xc2, 0xcd, 0x8b, 0x6d, 0x1f, 0xde, 0x95,
]);

const EXPECTED_PADDED_R = BigInt(
  "0xf6be389f442a709c765ea07986cf628ec60619b363b5bf6de5428f4a182419af",
);
const EXPECTED_PADDED_S = BigInt(
  "0xdaf45e4448e519c7ba561e44b1426609e520dd6c558dcf7dacc2cd8b6d1fde95",
);

// Known PEM public key for address derivation tests
const TEST_PEM = `-----BEGIN PUBLIC KEY-----
MFYwEAYHKoZIzj0CAQYFK4EEAAoDQgAEgrrst7wTpgzOxr7by7pa3tAqzSydrkqf
rX7KavCUQuk/gF1Ua8zgfUTzw2uj4/YOfwZOxM8kTAR799A+A7GqnQ==
-----END PUBLIC KEY-----`;

const TEST_RAW_PUB_KEY =
  "0x82baecb7bc13a60ccec6bedbcbba5aded02acd2c9dae4a9fad7eca6af09442e93f805d546bcce07d44f3c36ba3e3f60e7f064ec4cf244c047bf7d03e03b1aa9d";

// ── Hoisted mocks ───────────────────────────────────────────────────────────

// vi.mock factories are hoisted — all values they reference must be hoisted too
const { mockGetPublicKey, mockAsymmetricSign, mockGetVercelOidcToken } =
  vi.hoisted(() => ({
    mockGetPublicKey: vi.fn(),
    mockAsymmetricSign: vi.fn(),
    mockGetVercelOidcToken: vi.fn().mockResolvedValue("mock-oidc-token"),
  }));

vi.mock("@google-cloud/kms", () => ({
  KeyManagementServiceClient: vi.fn().mockImplementation(() => ({
    getPublicKey: mockGetPublicKey,
    asymmetricSign: mockAsymmetricSign,
    initialize: vi.fn(),
  })),
}));

vi.mock("@vercel/oidc", () => ({
  getVercelOidcToken: mockGetVercelOidcToken,
}));

vi.mock("google-auth-library", () => ({
  IdentityPoolClient: vi.fn().mockImplementation(() => ({})),
}));

// ── Env stubs ───────────────────────────────────────────────────────────────

const stubEnv = () => {
  vi.stubEnv("SUPABASE_URL", "https://test.supabase.co");
  vi.stubEnv("SUPABASE_ANON_KEY", "key");
  vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "key");
  vi.stubEnv("NEXT_PUBLIC_ONCHAINKIT_API_KEY", "key");
  vi.stubEnv("NEXT_PUBLIC_BASE_NETWORK", "testnet");
  vi.stubEnv("NEXT_PUBLIC_USDC_ADDRESS", "0x036CbD53842c5426634e7929541eC2318f3dCF7e");
  vi.stubEnv("GCP_KMS_KEY_PATH", "projects/test/locations/us-central1/keyRings/test/cryptoKeys/test/cryptoKeyVersions/1");
  vi.stubEnv("GCP_PROJECT_NUMBER", "123456789");
  vi.stubEnv("GCP_WORKLOAD_IDENTITY_POOL_ID", "test-pool");
  vi.stubEnv("GCP_WORKLOAD_IDENTITY_POOL_PROVIDER_ID", "vercel");
  vi.stubEnv("GCP_SERVICE_ACCOUNT_EMAIL", "test@test.iam.gserviceaccount.com");
};

// ── Tests ───────────────────────────────────────────────────────────────────

describe("kms-signer", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllEnvs();
    mockGetPublicKey.mockReset();
    mockAsymmetricSign.mockReset();
  });

  describe("parseDerSignature", () => {
    it("parses a valid DER signature with 32-byte r and 33-byte s (leading zero)", async () => {
      const { parseDerSignature } = await import("@/lib/contracts/kms-signer");
      const { r, s } = parseDerSignature(KNOWN_DER);

      expect(r).toBe(EXPECTED_R);
      expect(s).toBe(EXPECTED_S);
    });

    it("parses a DER signature with leading-zero-padded r and s", async () => {
      const { parseDerSignature } = await import("@/lib/contracts/kms-signer");
      const { r, s } = parseDerSignature(DER_WITH_PADDED_R);

      expect(r).toBe(EXPECTED_PADDED_R);
      expect(s).toBe(EXPECTED_PADDED_S);
    });

    it("throws on garbage bytes", async () => {
      const { parseDerSignature } = await import("@/lib/contracts/kms-signer");
      const garbage = new Uint8Array([0xff, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08]);

      expect(() => parseDerSignature(garbage)).toThrow(
        "Invalid DER: expected SEQUENCE tag (0x30)",
      );
    });

    it("throws on too-short input", async () => {
      const { parseDerSignature } = await import("@/lib/contracts/kms-signer");
      const tooShort = new Uint8Array([0x30, 0x03, 0x02, 0x01]);

      expect(() => parseDerSignature(tooShort)).toThrow("Invalid DER");
    });

    it("throws when second integer tag is missing", async () => {
      const { parseDerSignature } = await import("@/lib/contracts/kms-signer");
      // Valid first integer, but second tag is 0xff not 0x02
      const badDer = new Uint8Array([
        0x30, 0x06, 0x02, 0x01, 0x01, 0xff, 0x01, 0x01,
      ]);

      expect(() => parseDerSignature(badDer)).toThrow(
        "Invalid DER: expected INTEGER tag (0x02) for s",
      );
    });
  });

  describe("normalizeSValue", () => {
    it("returns low S values unchanged", async () => {
      const { normalizeSValue } = await import("@/lib/contracts/kms-signer");
      const lowS = BigInt("0x1234567890abcdef");
      expect(normalizeSValue(lowS)).toBe(lowS);
    });

    it("negates high S values (S > half_order)", async () => {
      const { normalizeSValue } = await import("@/lib/contracts/kms-signer");
      // EXPECTED_S is known to be > half_order
      expect(EXPECTED_S > SECP256K1_HALF_ORDER).toBe(true);

      const normalized = normalizeSValue(EXPECTED_S);
      expect(normalized).toBe(SECP256K1_ORDER - EXPECTED_S);
      expect(normalized <= SECP256K1_HALF_ORDER).toBe(true);
    });

    it("returns S exactly at half_order unchanged", async () => {
      const { normalizeSValue } = await import("@/lib/contracts/kms-signer");
      expect(normalizeSValue(SECP256K1_HALF_ORDER)).toBe(SECP256K1_HALF_ORDER);
    });

    it("negates S = half_order + 1", async () => {
      const { normalizeSValue } = await import("@/lib/contracts/kms-signer");
      const highS = SECP256K1_HALF_ORDER + BigInt(1);
      const normalized = normalizeSValue(highS);
      expect(normalized).toBe(SECP256K1_ORDER - highS);
      expect(normalized <= SECP256K1_HALF_ORDER).toBe(true);
    });
  });

  describe("derToEthSignature", () => {
    it("converts a DER signature to Ethereum r/s/v format with correct recovery", async () => {
      // Use Node.js crypto to generate a real secp256k1 signature,
      // then verify derToEthSignature recovers the correct address.
      const crypto = await import("crypto");
      const { keccak256, getAddress } = await import("viem");
      const { derToEthSignature } = await import("@/lib/contracts/kms-signer");

      // Generate a secp256k1 key pair
      const { privateKey, publicKey } = crypto.generateKeyPairSync("ec", {
        namedCurve: "secp256k1",
      });

      // Derive the Ethereum address from the public key
      const pubDer = publicKey.export({ type: "spki", format: "der" });
      const pubKeyHex = ("0x" + Buffer.from(
        pubDer.subarray(pubDer.length - 65).subarray(1),
      ).toString("hex")) as `0x${string}`;
      const hash = keccak256(pubKeyHex);
      const address = getAddress(("0x" + hash.slice(-40)) as `0x${string}`);

      // Node.js crypto.sign(null, data, ecKey) for EC keys applies SHA-256
      // before signing — same as GCP KMS with EC_SIGN_SECP256K1_SHA256.
      // The actual signed digest is SHA256(data), not the raw data.
      // So we must use SHA256(data) as the message hash for recovery.
      const data = Buffer.alloc(32, 0xab);
      const derSig = crypto.sign(null, data, {
        key: privateKey,
        dsaEncoding: "der",
      });

      // The actual digest that was signed is SHA256(data)
      const sha256Hash = crypto.createHash("sha256").update(data).digest();
      const actualDigest = ("0x" + sha256Hash.toString("hex")) as `0x${string}`;

      // Convert DER to Ethereum format using the actual signed digest
      const ethSig = await derToEthSignature(
        actualDigest,
        new Uint8Array(derSig),
        address,
      );

      // r and s should be 32-byte hex strings
      expect(ethSig.r).toMatch(/^0x[0-9a-f]{64}$/);
      expect(ethSig.s).toMatch(/^0x[0-9a-f]{64}$/);
      expect(ethSig.v === BigInt(27) || ethSig.v === BigInt(28)).toBe(true);

      // s should be in the lower half of the curve order (low-S normalization)
      const sValue = BigInt(ethSig.s);
      expect(sValue <= SECP256K1_HALF_ORDER).toBe(true);
    });

    it("throws when neither v=27 nor v=28 recovers the correct address", async () => {
      const { derToEthSignature } = await import("@/lib/contracts/kms-signer");

      // Use a valid DER signature but with the wrong address
      const wrongAddress = "0x0000000000000000000000000000000000000001" as `0x${string}`;
      const msgHash = ("0x" + "ab".repeat(32)) as `0x${string}`;

      await expect(
        derToEthSignature(msgHash, KNOWN_DER, wrongAddress),
      ).rejects.toThrow("Could not determine recovery parameter v");
    });
  });

  describe("getEthAddressFromKms", () => {
    it("derives Ethereum address from KMS PEM public key", async () => {
      stubEnv();

      mockGetPublicKey.mockResolvedValue([{ pem: TEST_PEM }]);

      const { getEthAddressFromKms, _resetKmsClients } = await import(
        "@/lib/contracts/kms-signer"
      );

      // Compute expected address from raw public key
      const { keccak256, getAddress } = await import("viem");
      const hash = keccak256(TEST_RAW_PUB_KEY as `0x${string}`);
      const expectedAddress = getAddress(
        ("0x" + hash.slice(-40)) as `0x${string}`,
      );

      const address = await getEthAddressFromKms();
      expect(address).toBe(expectedAddress);

      _resetKmsClients();
    });

    // Known-vector sanity check — verifies the PEM parsing + keccak256 math
    // against a well-known secp256k1 test vector, independent of KMS.
    //
    // Test vector: secp256k1 generator point G (corresponds to private key = 1)
    //   x: 79BE667EF9DCBBAC55A06295CE870B07029BFCDB2DCE28D959F2815B16F81798
    //   y: 483ADA7726A3C4655DA4FBFC0E1108A8FD17B448A68554199C47D08FFB10D4B8
    //   Ethereum address: 0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf
    // This is the canonical starting point of secp256k1; the derived address
    // is widely documented (e.g. Bitcoin generator -> Ethereum address).
    it("derives the known Ethereum address for secp256k1 generator point G", async () => {
      stubEnv();

      // SPKI PEM for the G point — constructed from the standard DER template
      // Header: 3056301006072a8648ce3d020106052b8104000a03420004 (23 bytes)
      //   SEQUENCE { SEQUENCE { OID ecPublicKey, OID secp256k1 }, BIT STRING { 0x04 || x || y } }
      const G_POINT_PEM = `-----BEGIN PUBLIC KEY-----
MFYwEAYHKoZIzj0CAQYFK4EEAAoDQgAEeb5mfvncu6xVoGKVzocLBwKb/NstzijZ
WfKBWxb4F5hIOtp3JqPEZV2k+/wOEQio/Re0SKaFVBmcR9CP+xDUuA==
-----END PUBLIC KEY-----`;

      const KNOWN_G_ADDRESS = "0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf";

      mockGetPublicKey.mockResolvedValue([{ pem: G_POINT_PEM }]);

      const { getEthAddressFromKms, _resetKmsClients } = await import(
        "@/lib/contracts/kms-signer"
      );

      const address = await getEthAddressFromKms();
      expect(address).toBe(KNOWN_G_ADDRESS);

      _resetKmsClients();
    });
  });

  describe("createKmsAccount", () => {
    it("returns a viem-compatible account with correct address and nonceManager", async () => {
      stubEnv();

      mockGetPublicKey.mockResolvedValue([{ pem: TEST_PEM }]);
      mockAsymmetricSign.mockResolvedValue([{ signature: KNOWN_DER }]);

      const { createKmsAccount, _resetKmsClients } = await import(
        "@/lib/contracts/kms-signer"
      );

      const account = await createKmsAccount();

      // Should have an address
      expect(account.address).toMatch(/^0x[0-9a-fA-F]{40}$/);

      // Should have signing functions
      expect(typeof account.signMessage).toBe("function");
      expect(typeof account.signTransaction).toBe("function");
      expect(typeof account.signTypedData).toBe("function");

      // Should have nonceManager attached (NOR-188 / AUD-003)
      expect(account.nonceManager).toBeDefined();

      // Should have type 'local'
      expect(account.type).toBe("local");

      _resetKmsClients();
    });
  });
});
