/**
 * Compiled-in releases for the bands published outside npm — §02.2, §06.1.
 *
 * An `embedded` registry spec names a key here, and what is under it is the
 * band's whole answer to both of §04's and §06's questions: which versions exist
 * (the keys), and which bytes each host must receive (`<algo>.<hex>`, keyed by
 * the `{target}` the band maps the host onto — so two hosts sharing one artifact
 * share one line).
 *
 * The block between the markers is written by `scripts/refresh-table.mjs`, which
 * downloads every artifact it adds from `repo.yarnpkg.com` and compares it with
 * the digest GitHub publishes for the same release asset; nothing here is a
 * digest the script was merely told. An existing line is never rewritten — a
 * release whose bytes change after it was recorded fails the refresh instead.
 *
 * Cold by construction: only `net/registry.ts` and `cache/install.ts` read it,
 * and neither is on the warm path (§16, Build shape). `config/table.ts` must not
 * import it.
 */

import type { EmbeddedRegistrySpec } from "../types.ts";

type Releases = Readonly<Record<string, Readonly<Record<string, string>>>>;

const RELEASES: Readonly<Record<string, Releases>> = {
  // BEGIN GENERATED RELEASES
  "yarnpkg/zpm": {
    "6.0.0-rc.22": {
      "aarch64-apple-darwin":
        "sha256.921318406a4c6c0258adb639393dde88162f127758ed75f99fcede6f50eb33b8",
      "aarch64-unknown-linux-musl":
        "sha256.ddb065967fcdee03138071bc8bcb8e8cddde6fb3cf81866160c83fdb0e5e8ce1",
      "x86_64-unknown-linux-musl":
        "sha256.30ba4fc6740048bec70380ed33ed4cc659b6a5a1882638233b6de9cd1e4eb977",
    },
    "6.0.0-rc.21": {
      "aarch64-apple-darwin":
        "sha256.459f945147c3d0a1224ea5b01b34ec44d23f9fb5089ebd66958fdaa9d4f4431a",
      "aarch64-unknown-linux-musl":
        "sha256.533eb126c468b4c36b629f225b7d6cd8dbee809291e193cc16761227a2b6444d",
      "x86_64-unknown-linux-musl":
        "sha256.27a887498211009a7e60ac27919185bb5f47c241a64f24017818f08ac36bbd5c",
    },
    "6.0.0-rc.20": {
      "aarch64-apple-darwin":
        "sha256.30b9b9f82fcd88952068bf9206f54e8c08dfecf9b15e3b80465166966bca3708",
      "aarch64-unknown-linux-musl":
        "sha256.09bb5a201181fbc30b0c708b21c832f0f971ed4557839547fc184cb65d6448cb",
      "x86_64-unknown-linux-musl":
        "sha256.e1f43158e134eacee1977196cf880993dddc007d85073210376ca3674793c8d9",
    },
    "6.0.0-rc.19": {
      "aarch64-apple-darwin":
        "sha256.3485e3aec467ec56d26e3b3fed027abe82138fafdb7d8ae4f068ec32f6fe40ad",
      "aarch64-unknown-linux-musl":
        "sha256.6fe819dd534def034aa6ba6bb9263f6a2d7b3e03a4486278b3a5a9c38e1dd104",
      "x86_64-unknown-linux-musl":
        "sha256.9618233c0b659ca716ab1c591a00aacc0facc39e7ac7119042ce6b4fd3840bce",
    },
    "6.0.0-rc.18": {
      "aarch64-apple-darwin":
        "sha256.6db6650e90a7a1b70528d64abef1e379361936ed4cb705949e2abe1f7d454e2d",
      "aarch64-unknown-linux-musl":
        "sha256.e4921b79e26d5b8e0494d9fa4dadc97e24197fcbbc6596ed4186643e2214ccf8",
      "x86_64-unknown-linux-musl":
        "sha256.235866fef731055060ba3a5e9f1cdfdc2646d4d1dffff9ec70512e53200874c8",
    },
    "6.0.0-rc.17": {
      "aarch64-apple-darwin":
        "sha256.39acfef153c28ef7467f50c629fb8e73449b7f1be4a1be7cd3da172d0ab13cc5",
      "aarch64-unknown-linux-musl":
        "sha256.0b8968a364a879a6418968971e7ab6930a207c7753a206ee0bdd75d8f65a61d6",
      "x86_64-unknown-linux-musl":
        "sha256.38522fae0162428b889596749b1651cbc766133278e29af72e61502dd0bf8a20",
    },
    "6.0.0-rc.16": {
      "aarch64-apple-darwin":
        "sha256.b4cf00ae6e34927e4930e4c900171a14a4c4567d0709393e40668c517e2d1479",
      "aarch64-unknown-linux-musl":
        "sha256.428a242504e7f5daf5fd32d6313b6a0c44929d63fe77e903a3bcaddbc1366522",
      "x86_64-unknown-linux-musl":
        "sha256.ec70d59ed38f4d1c9a9eb912726cceae2d790807ddfe6469ca9e6b436a37d7b2",
    },
    "6.0.0-rc.15": {
      "aarch64-apple-darwin":
        "sha256.654f70b61df88224104b99e320dc4022de70e556e264a71a67f2628433eeffa8",
      "aarch64-unknown-linux-musl":
        "sha256.805408c063eee03eb91d91944c06359eed97f9347a644d0eec1a39bf6cae6feb",
      "x86_64-unknown-linux-musl":
        "sha256.b546c58118e0c010cf47006c638bddac84b338073ac4fddb0bf6ade44fde6645",
    },
    "6.0.0-rc.14": {
      "aarch64-apple-darwin":
        "sha256.30cf36b0a8485f4839c4194170287d6c909da40ce859a4e7c058a2591d3e8691",
      "aarch64-unknown-linux-musl":
        "sha256.5183e4b71d669490b7a9cf65345ab9dd62c4367ebf7a302befc963d77981197c",
      "x86_64-unknown-linux-musl":
        "sha256.f0b837ea95ea459ecfb9ae6b588afad39043a908b019dbea2a7db66af7a02bfe",
    },
    "6.0.0-rc.13": {
      "aarch64-apple-darwin":
        "sha256.3ebd3866de11a21c50fee119d7b7d5e3ad52c996bd47ce4a2b2f8a790db34bcf",
      "aarch64-unknown-linux-musl":
        "sha256.5fc98862f9e588c60c76fb30d11a3e3151d1aa9654acf6faa7f3d534f6357085",
      "x86_64-unknown-linux-musl":
        "sha256.0d4e6289e2f6baa5a0e49419ee5baafa4e46715b95a1481766ee9e288efc79a1",
    },
    "6.0.0-rc.12": {
      "aarch64-apple-darwin":
        "sha256.a33e41acb5d485ec1ba6cdea4257d96ed4550db5f9cb450e0b20858e5a964a7d",
      "aarch64-unknown-linux-musl":
        "sha256.776816a796bdf4738efb66197f233dc025bbafa2ba1bf8dbc51133de73b180d3",
      "x86_64-unknown-linux-musl":
        "sha256.651d662d43f115ffc649cfb18195cd936c657be04d92305aa52d85c231e3a806",
    },
    "6.0.0-rc.11": {
      "aarch64-apple-darwin":
        "sha256.ce644ac88b559d5f39eab887553ed725529d61e5a87671171f907aa2ebc05cc0",
      "aarch64-unknown-linux-musl":
        "sha256.84ac0f84c721b0b0fd59753d8797f4ab6e8420a0e5532ad33ac5d18d5019e57f",
      "x86_64-unknown-linux-musl":
        "sha256.dec9cc2760e543eb5ee07b5ddc1af684e20f6bdc0ca08e4c51f1929b6566d627",
    },
    "6.0.0-rc.10": {
      "aarch64-apple-darwin":
        "sha256.cd7bc058d50f66f6cd0b78815bdc4ee5268e802aeabab5995d4126cd666ea28f",
      "aarch64-unknown-linux-musl":
        "sha256.14d742f72866d4fe402a6d2de4f35d7e50c34e9daf4c426ce5c79349858e8069",
      "x86_64-unknown-linux-musl":
        "sha256.f477c4c0f9211742147e0c3b3c99cebd66d919e7529c9a411cdda76854d1bf47",
    },
    "6.0.0-rc.9": {
      "aarch64-apple-darwin":
        "sha256.0e538156228cf4ec8557791d9beb0b5535aa4cb6102c047498b6a26f44a18e7d",
      "aarch64-unknown-linux-musl":
        "sha256.05407aa3ebcab7c4891b3f6e1a0961487f5942739413fda76fc197fcdee3d180",
      "x86_64-unknown-linux-musl":
        "sha256.517b508adb69b8e31c29cd69fa3111e0f4fd88e375c8db23a0b6083233f71e5c",
    },
    "6.0.0-rc.8": {
      "aarch64-apple-darwin":
        "sha256.84724cdea59568c25247475f54338d985d172914839b73bab2a980df863be0fe",
      "aarch64-unknown-linux-musl":
        "sha256.91c5cfbb3fccc0784522bf251e858af79ad8876220a03714b63c792355dced74",
      "x86_64-unknown-linux-musl":
        "sha256.d16d84732650e8874a57e6941b39201aac4e23922aeccfffd2098f3c68c586bf",
    },
    "6.0.0-rc.7": {
      "aarch64-apple-darwin":
        "sha256.76fbf9ed5f32e71a363139c0f792e974a0deb56271cb087d83da5f307e9b48f6",
      "aarch64-unknown-linux-musl":
        "sha256.8e9525879974d3329ccf56f9ea7b8d3b51ef6c1ec445b894c2175954c1b43b37",
      "x86_64-unknown-linux-musl":
        "sha256.3bc19c587c2853e1ec639ba8b2acb146c53d346646b2c996ab43409b39ed2cce",
    },
    "6.0.0-rc.6": {
      "aarch64-apple-darwin":
        "sha256.eeb2dd2a6629afe688ff5f76f76b1f6df595ce26fc2f8fbf0c5f7b3670b2bbf8",
      "aarch64-unknown-linux-musl":
        "sha256.d9c2a901fd7a56e9ada60dcb6f73f11d713500fc0500e076ca7e84e85e6f9f3d",
      "x86_64-unknown-linux-musl":
        "sha256.1f04ba38d733bfc1716633413de5e78e1b9c217651ef7e700b5180bdcfde83e2",
    },
    "6.0.0-rc.5": {
      "aarch64-apple-darwin":
        "sha256.84d8528569c32cb2e7db219ac3c1e80c472539556142d78f105d57f0d816e5e9",
      "aarch64-unknown-linux-musl":
        "sha256.574abe7b1d6b9280e50b6cf65791fbf937072ba1802ce12adc06513361454e6f",
      "x86_64-unknown-linux-musl":
        "sha256.afb8ae4d5c999e2026a5004025866f17f48c5f584945288f149ce757c207a47a",
    },
    "6.0.0-rc.4": {
      "aarch64-apple-darwin":
        "sha256.c8feffeed58ee110d26324045621896d868b17ffa8e12db13a05d1c53f9bec59",
      "aarch64-unknown-linux-musl":
        "sha256.62e2659836db6746323415361161e6621c782c4ba1130c66f996311d4c235dda",
      "x86_64-unknown-linux-musl":
        "sha256.c49e86c5d8da18a88c07382350ab0bb99b1f07a2d648bf3d40e7292f280e1c8a",
    },
    "6.0.0-rc.3": {
      "aarch64-apple-darwin":
        "sha256.7b498cd32e5d86986b6b39213c9f940712648fb56381be19257b9a40e43c056e",
      "aarch64-unknown-linux-musl":
        "sha256.533e0a7b4b97f7d0041840b93415e4c24f0e708e0ef605cae4d7bc24d5eb5062",
      "x86_64-unknown-linux-musl":
        "sha256.89660bf977675d4cfa746322a23066f6bd6e6c8c7454c3eef93887afb943bf87",
    },
    "6.0.0-rc.2": {
      "aarch64-apple-darwin":
        "sha256.d3be2dcc4a5b7951e20a1699c44828566660a35c2802037deca6e17c419e19e3",
      "aarch64-unknown-linux-musl":
        "sha256.0246ae2640fd0662809793119d12b7b477c1ed376add2923830aa525723c34bf",
      "x86_64-unknown-linux-musl":
        "sha256.bf3276faad55becc9937602c7e621f7502b96b54e7f361d119f03b7537731386",
    },
    "6.0.0-rc.1": {
      "aarch64-apple-darwin":
        "sha256.f6ccf4e32c83d788018dbac30642fadeb89886e58375fcc68a75eb8d18ba79d6",
      "aarch64-unknown-linux-musl":
        "sha256.0e7091b37ddb1b97e2ac56ba80bf238fd72debd1d6ff4f1b5f50e7824fd8f4b0",
      "x86_64-unknown-linux-musl":
        "sha256.73c1646d1b7522bf4ea84b0a90d6ab220d9e8eb38fa8cf076bfe20d13987e1fe",
    },
    "6.0.0-rc.0": {
      "aarch64-apple-darwin":
        "sha256.55be18e747b6157da620968320083e8072577a8dc9efff9f79aace6bba4ce3f9",
      "aarch64-unknown-linux-musl":
        "sha256.d4ee8ad8cd77a2b45621e423259a25cb46a39520c470c8061a39b3fe2b4ec0d0",
      "x86_64-unknown-linux-musl":
        "sha256.39248d53dfb3698748b155c0b572e5f1c18618a46c1e9d57d203644c5b9d053e",
    },
  },
  // END GENERATED RELEASES
};

/** Every version the band lists, in no particular order. */
export function embeddedVersions(spec: EmbeddedRegistrySpec): string[] {
  const releases = RELEASES[spec.releases];
  return releases === undefined ? [] : Object.keys(releases);
}

/**
 * §06.1 — the compiled-in digest of `version`'s artifact for `target`, as
 * `{ algo, hex }`, or `undefined` when the table does not know that release or
 * that host's build of it.
 */
export function embeddedDigest(
  spec: EmbeddedRegistrySpec,
  version: string,
  target: string,
): { algo: string; hex: string } | undefined {
  const releases = RELEASES[spec.releases];
  if (releases === undefined || !Object.hasOwn(releases, version)) return undefined;
  const hosts = releases[version]!;
  if (!Object.hasOwn(hosts, target)) return undefined;
  const pinned = hosts[target]!;
  const dot = pinned.indexOf(".");
  return { algo: pinned.slice(0, dot), hex: pinned.slice(dot + 1) };
}
