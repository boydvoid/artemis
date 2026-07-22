// The Artemis mark: three bars and a forward arrow.
//
// Inlined from `assets/artemis logo.svg` (the design source of record) rather
// than referenced as an image, so it paints in `currentColor` — the app's one
// amber — instead of the source file's fixed `#f2af0d`, which would read as a
// mismatch next to amber UI. The geometry and its transforms are verbatim; the
// only edit is the fill.

export default function Logo(props: { className?: string }) {
  return (
    <svg
      viewBox="0 0 3221 1356"
      className={props.className}
      fill="currentColor"
      role="img"
      aria-label="Artemis"
      xmlns="http://www.w3.org/2000/svg"
    >
      <g transform="matrix(1,0,0,1,-132.055589,-1912.247416)">
        <g transform="matrix(1.847404,0,0,1.847404,-1809.189929,-1043.549632)">
          <g transform="matrix(0,1,-1,0,4383.918622,1064.704561)">
            <path d="M902.222,1589.725L1086.219,1826.58L718.226,1826.58L902.222,1589.725Z" />
          </g>
          <g transform="matrix(5.289897,0,0,1,-4337.212429,20.501654)">
            <rect x="1018.547" y="1854.947" width="260.752" height="182.957" />
          </g>
          <g transform="matrix(2.644949,0,0,1,-953.532737,295.976885)">
            <rect x="1018.547" y="1854.947" width="260.752" height="182.957" />
          </g>
          <g transform="matrix(2.644949,0,0,1,-953.532737,-254.973576)">
            <rect x="1018.547" y="1854.947" width="260.752" height="182.957" />
          </g>
        </g>
      </g>
    </svg>
  );
}
