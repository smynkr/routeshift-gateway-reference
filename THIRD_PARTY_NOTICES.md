# Third-party notices and data scope

The root Apache-2.0 license covers the contributors' original work, not every third-party component that a package manager or build downloads. This release distributes source and lockfiles, not `node_modules`, font binaries, built dashboard assets or container images.

## LiteLLM-derived model and pricing data — MIT

The following snapshots under `packages/shared/src/` include data transformed from [BerriAI/LiteLLM](https://github.com/BerriAI/litellm):

- `litellm-pricing.generated.ts`
- `generated-model-catalog.ts`
- `catalog-freshness.generated.ts`
- `current-models.generated.ts`
- `docs-catalog.generated.json`

Their source URL, generation timestamp and source hash remain in the generated artifacts. The historical source terms were verified at [upstream revision 90073864ece70a50155dfd405315f6b7dba87287](https://github.com/BerriAI/litellm/blob/90073864ece70a50155dfd405315f6b7dba87287/LICENSE): content outside its separately licensed enterprise directory is MIT. No enterprise source is included here. The generator's original transformation code is distinct from the upstream data it transforms.

> MIT License
>
> Copyright (c) 2023 Berri AI
>
> Permission is hereby granted, free of charge, to any person obtaining a copy
> of this software and associated documentation files (the "Software"), to deal
> in the Software without restriction, including without limitation the rights
> to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
> copies of the Software, and to permit persons to whom the Software is
> furnished to do so, subject to the following conditions:
>
> The above copyright notice and this permission notice shall be included in all
> copies or substantial portions of the Software.
>
> THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
> IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
> FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
> AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
> LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
> OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
> SOFTWARE.

## Historical provider facts and authored routing choices

`packages/shared/src/models.ts` and `cost-tables.ts` contain independently curated interoperability identifiers, numeric limits, historical token prices and contributor-authored routing choices. `model-sources.ts` retains the available provider source links and their last-verification dates. These are frozen inputs, not a current commercial quotation or a claim that every row has been freshly verified for this release. Some legacy rows lack a complete value-level source history.

The archive claims no exclusive copyright in facts and does not purport to license provider services, model weights, trademarks or any protected third-party expression. The original arrangement and routing code are contributor work. Source citations alone are not a general grant of provider rights: downstream users must independently check applicable service terms and current pricing before use. No row-level contractual-clearance or worldwide database-rights opinion is supplied.

The separate vendor/paper/Arena benchmark-score snapshot was omitted, together with its optional dashboard display and sorting, rather than attributing unsupported data rights or publishing synthetic replacement scores.

## Dependencies and assets obtained during builds

The package lockfiles identify the exact dependency versions used by this source snapshot. Each installed package supplies its own terms. Examples that require separate attention when redistributing a downstream build:

| Component | Recorded license | Distribution boundary |
|---|---|---|
| Sentry CLI 2.58.5 and matching platform package | FSL-1.1-MIT | Build tooling with its own use restrictions and future-license terms; not relicensed here |
| Optional macOS `@img/sharp-libvips-darwin-arm64` 1.2.4 | LGPL-3.0-or-later | Native payload may require notices, corresponding source and replacement/relinking provisions when redistributed |
| `caniuse-lite` 1.0.30001791 | CC-BY-4.0 | Preserve applicable attribution/license/source if the data is redistributed |
| DM Sans | SIL Open Font License 1.1 | Copyright 2014 The DM Sans Project Authors; downloaded by the dashboard build |
| JetBrains Mono | SIL Open Font License 1.1 | Copyright 2020 The JetBrains Mono Project Authors; downloaded by the dashboard build |
| Instrument Serif | SIL Open Font License 1.1 | Copyright 2022 The Instrument Serif Project Authors; downloaded by the dashboard build |

Font source and license records: [DM Sans](https://github.com/google/fonts/tree/main/ofl/dmsans), [JetBrains Mono](https://github.com/google/fonts/tree/main/ofl/jetbrainsmono), [Instrument Serif](https://github.com/google/fonts/tree/main/ofl/instrumentserif). Preserve their OFL/copyright notices with any redistributed font binaries and observe reserved-name conditions if modifying fonts.

This is a source-bound notice, not an exhaustive license report for every platform-specific dependency resolution or downstream bundle. Running the supplied Dockerfiles creates new dependency/font-containing images locally; those images are not release assets. Audit the resulting contents and carry their notices before redistributing them.
