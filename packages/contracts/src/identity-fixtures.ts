export const identityVerificationFixtures = [
  {
    "reference": "document-readable",
    "sha256": "b3e265d3da719c16ddbc34d1b9a7ea081933875959fd662fa9a3a0e33823896d",
    "corpusVersion": "synthetic-identity.v1",
    "step": "document",
    "labels": {
      "es-CO": "Documento legible",
      "en-US": "Readable document"
    },
    "assetPath": "fixtures/identity/document-readable.png"
  },
  {
    "reference": "document-unreadable",
    "sha256": "221ea5ed8bc598fec2009f637bc675cf3dcca04a097bb6bebe154080ac17d686",
    "corpusVersion": "synthetic-identity.v1",
    "step": "document",
    "labels": {
      "es-CO": "Documento ilegible",
      "en-US": "Unreadable document"
    },
    "assetPath": "fixtures/identity/document-unreadable.png"
  },
  {
    "reference": "document-technical",
    "sha256": "913a8e77fba8a001d75cd5780d7dc16b825cdf13ee9360e751c6128082fa6fce",
    "corpusVersion": "synthetic-identity.v1",
    "step": "document",
    "labels": {
      "es-CO": "Documento: fallo técnico",
      "en-US": "Document: technical failure"
    },
    "assetPath": "fixtures/identity/document-technical.png"
  },
  {
    "reference": "selfie-matched",
    "sha256": "f223bcbd2516379f9d8d9f4c054dbfdcf0cd04c663bedeb6ac0af91cb4322dbf",
    "corpusVersion": "synthetic-identity.v1",
    "step": "selfie",
    "labels": {
      "es-CO": "Selfie coincidente",
      "en-US": "Matching selfie"
    },
    "assetPath": "fixtures/identity/selfie-matched.png"
  },
  {
    "reference": "selfie-mismatched",
    "sha256": "4514a02c0abfddd70c0fdc2ed8492e19df2ddcc87b231c3dd2aad8eb7aaa05ed",
    "corpusVersion": "synthetic-identity.v1",
    "step": "selfie",
    "labels": {
      "es-CO": "Selfie no coincidente",
      "en-US": "Nonmatching selfie"
    },
    "assetPath": "fixtures/identity/selfie-mismatched.png"
  },
  {
    "reference": "selfie-review",
    "sha256": "89a85e729fc3f5606064c5977bef3b591dbbaaab046c1798757dcb15624034d5",
    "corpusVersion": "synthetic-identity.v1",
    "step": "selfie",
    "labels": {
      "es-CO": "Selfie para revisión",
      "en-US": "Selfie for review"
    },
    "assetPath": "fixtures/identity/selfie-review.png"
  },
  {
    "reference": "liveness-passed",
    "sha256": "af97903666956d3ad463a1b9a391c6ce04f533e56c4a40f6f74e2362f48a8a5b",
    "corpusVersion": "synthetic-identity.v1",
    "step": "liveness",
    "labels": {
      "es-CO": "Prueba de vida válida",
      "en-US": "Passing liveness sample"
    },
    "assetPath": "fixtures/identity/liveness-passed.png"
  },
  {
    "reference": "liveness-failed",
    "sha256": "287ac71f2d8a65736985b6dc3fe488e5799ecdce09787e2a5725983dc4201f5c",
    "corpusVersion": "synthetic-identity.v1",
    "step": "liveness",
    "labels": {
      "es-CO": "Prueba de vida fallida",
      "en-US": "Failing liveness sample"
    },
    "assetPath": "fixtures/identity/liveness-failed.png"
  },
  {
    "reference": "liveness-screening-match",
    "sha256": "cc5534c4b4f362afe2f4514788f2d9ae50063410e50dbb49d6c7fd4d73b1a8a6",
    "corpusVersion": "synthetic-identity.v1",
    "step": "liveness",
    "labels": {
      "es-CO": "Coincidencia AML simulada",
      "en-US": "Simulated AML match"
    },
    "assetPath": "fixtures/identity/liveness-screening-match.png"
  }
] as const;
