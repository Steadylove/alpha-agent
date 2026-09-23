# Report typography

Chakra Petch Regular (400) and Medium (500) are used for compact report labels, captions, and annotations.

- Source: https://github.com/google/fonts/tree/main/ofl/chakrapetch
- License: SIL Open Font License 1.1; see `ChakraPetch-OFL.txt`.
- `ChakraPetch-glyphs.json` contains outlines and advance widths derived from the two TTF files with FontTools. Code points U+0020–U+024F and U+2000–U+22FF are included where present in the original fonts.
- The renderer embeds only the used glyph paths in the SVG, avoiding platform-specific font substitution. Latin capitals and CJK text share a visual centerline.
- Chinese fallback: Hiragino Sans GB on macOS, Noto Sans CJK SC on Linux. Report titles retain Georgia Italic.
