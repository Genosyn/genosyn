# Signing PDF fonts

Genosyn embeds the following fonts in completed signing PDFs so recipient names
and field values are preserved without ASCII transliteration:

- Noto Sans Regular
- Noto Sans Italic
- Noto Sans Arabic Regular
- Noto Sans SC Regular

The font files are distributed under the SIL Open Font License 1.1. Each
family's upstream license text is included beside the binaries:

- `OFL-NotoSans.txt`
- `OFL-NotoSansArabic.txt`
- `OFL-NotoSansSC.txt`

They were obtained from the canonical Noto Fonts repositories:

- <https://github.com/notofonts/noto-fonts/tree/main/hinted/ttf/NotoSans>
- <https://github.com/notofonts/noto-fonts/tree/main/hinted/ttf/NotoSansArabic>
- <https://github.com/google/fonts/tree/main/ofl/notosanssc>

Static font builds are intentional. They render consistently through
`@pdf-lib/fontkit` subsetting in both browser and server PDF viewers. Noto Sans
SC is the exception: `fontkit` silently drops high-numbered CJK glyphs when it
subsets this family, so Genosyn embeds that font intact only when a document
contains CJK text. This favors an accurate signed artifact over file size. The
static weight-400 build is generated from the upstream variable TrueType file
without changing its outlines or license.

The App server build copies this directory to `dist/server/assets`, matching
the relative path used by the TypeScript source and compiled server.
