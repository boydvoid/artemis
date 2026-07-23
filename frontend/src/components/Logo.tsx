// The Artemis mark: the gold "A" with a forward arrow.
//
// The transparent `NoBGIcon` export, imported so Vite fingerprints and bundles
// it. Used on purpose over the black rounded-square treatment — that squircle
// is the OS app icon (assets/icon.png), while in-app the glyph sits directly
// on the app's own surfaces. The .svg is a self-contained export (an embedded
// raster), so it renders like an image rather than inheriting currentColor.

import logoSrc from "@/assets/logo.svg";

export default function Logo(props: { className?: string }) {
  return (
    <img
      src={logoSrc}
      className={props.className}
      alt="Artemis"
      draggable={false}
    />
  );
}
