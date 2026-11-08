# Offline Switch 1 title catalog

This directory supplies **display metadata**, not a game compatibility list, an installed-title inventory or permission to launch a game. Application IDs and local communication IDs (LCIDs) are separate namespaces.

## Frozen inputs and license

The bulk source is the community-maintained, metadata-only [blawar/titledb](https://github.com/blawar/titledb), pinned to commit [`d424690446eec6f4484209b9a1c067c7f7511398`](https://github.com/blawar/titledb/tree/d424690446eec6f4484209b9a1c067c7f7511398). It declares the MIT license; the exact notice is included in `LICENSE.titledb`. This is not Nintendo attestation or endorsement.

`source-lock.json` pins the US/GB English and CN/HK Chinese regional files, their byte lengths, Git blob hashes, sanitized content hashes and license hash. `provenance.json` adds SHA-256 digests of the original public source bytes, the generator and curated inputs, plus the selected source file/NSUID for each name.

The factual simplified Sword label **宝可梦 剑** is checked against Nintendo's [official simplified-Chinese announcement](https://www.nintendo.com/hk/topics/article/a_190812_01_sc.html), with a [second publisher reference](https://www.nintendo.com/hk/topics/article/a_200326_03_sc.html). Only this checked label is overridden; missing Chinese names are not automatically translated. The two additional curated labels and LCID observations publish only their limited selected title records, observation date and method. Their fingerprint covers those public records alone. No whole-device cache fingerprint, user path, device identifier or wider user inventory is retained.

## Data contract

- `catalog.json`: `schema: 1`, `source_commit`, `scope`, and sorted `records` containing **`appid`**, **`en`**, **`zh`**, **`zh_locale`**. IDs are uppercase hex16. A language can be empty. Chinese mainland names are preferred; HK fallback is identified as `zh-Hant-HK` by source locale and is not machine-converted. Roman-only HK names are not counted as Chinese translations.
- `lcid-mappings.json`: only explicit limited NACP observations. Each entry has `lcid`, observed `appids`, evidence IDs, `ambiguous`, `exhaustive: false`, `unknown_additional_candidates_possible: true`, and `launch_authority: false`.
- `raw_appid_catalog_candidates` is separate from observed NACP `appids`. Numeric equality alone is a **display-only catalog candidate**, never proof that AppID equals LCID.
- `curated-labels.json` and `lcid-observations.json` contain the readable evidence and limited public observations.
- `name-conflicts.json` retains differing regional/source names; it does not merge application identities. Selection is deterministic: base entry before demo, preferred source locale, then numeric NSUID and name.

For the two Violet-related LCIDs, ambiguity was observed and remains explicit. The Scarlet AppID-valued shared identifier has Violet in its observed NACP list and Scarlet only as a separate raw-ID catalog candidate. Unknown further applications remain possible. A single published candidate must not be treated as a globally unique LCID mapping.

For **0100ABF008968000**, the catalog supplies **Pokémon™ Sword / 宝可梦 剑**. There is **no independent Sword NACP relation** in these inputs. A screenshot displaying that raw LCID may therefore receive a labeled catalog-candidate title. Local NS/NACP queries must independently establish availability, installed state and launch suitability.

## Coverage of the pinned sample

| Measure | Count |
|---|---:|
| Unique eligible Switch 1 base AppIDs | 20,910 |
| English regional names | 19,999 |
| Chinese names | 3,530 |
| Both languages | 2,619 |
| Simplified Chinese / curated Hans | 65 |
| Identified HK Chinese fallback | 3,465 |
| Regional name conflict groups | 842 |
| Explicit observed LCID relations | 3 |
| Known ambiguous LCIDs | 2 |

`coverage.json` includes per-source raw/accepted/excluded counts. These figures describe the pinned input sample, **not every Switch game worldwide** and not supported multiplayer games. Base application IDs can include demos when a valid ID is supplied.

Filtering accepts only exact Switch 1 application IDs (`0100…`, base allocation alignment, application range) and base/demo NSUID product types. Update/subprogram IDs, DLC, bundles, Switch 2 IDs, missing IDs and invalid names are excluded. The persisted field allowlist is limited to identifiers and names. Keys, rights IDs, image URLs/files, descriptions, cheats, NCA/CNMT data and game content are not copied.

## Rebuild and verify

```sh
# Rebuild offline from the existing sanitized OS-temp cache:
python3 -B compatibility/title-catalog/generator.py

# Re-fetch the immutable pinned regional metadata when no cache is present:
python3 -B compatibility/title-catalog/generator.py --fetch

# Optional explicit cache directory outside the source tree:
python3 -B compatibility/title-catalog/generator.py --fetch --cache-dir /tmp/lanywhere-title-catalog-cache

python3 -B compatibility/title-catalog/test_generator.py
```

Raw downloaded metadata is streamed and never written to disk. Sanitized per-region rebuild caches are stored in the OS temporary directory (or the explicit `--cache-dir`), outside tracked/exported paths. No images are fetched. Both network and offline paths check pinned source/snapshot integrity. Output JSON is deterministically sorted; no current-time field changes output bytes. Tests cover namespace exclusions, prohibited-field removal, split UTF-8 parsing, deterministic output, source corruption rejection, partial LCID ambiguity, Sword labeling and absence of private inventory traces.

A catalog refresh is an explicit maintenance action. No recurring or monthly task is created.
