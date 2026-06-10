// Brand mark — a property graph shaped like the letter Q (for SQL/PGQ):
// five nodes on a ring connected as a cycle, plus a "tail" edge from the
// lower-right ring node out to a sixth node. Inherits `currentColor` so the
// mark recolours for whichever accent palette is active.

interface LogoProps {
  className?: string;
}

export function Logo({ className }: LogoProps) {
  return (
    <svg
      viewBox="0 0 48 48"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
      aria-hidden
    >
      {/* Ring cycle — the Q's bowl. */}
      <path
        d="M22 8 L34.4 17 L29.6 31.5 L14.4 31.5 L9.6 17 Z"
        stroke="currentColor"
        strokeWidth={2.25}
        strokeLinejoin="round"
        strokeLinecap="round"
        opacity={0.6}
      />
      {/* Tail edge — the Q's descender. */}
      <path
        d="M29.6 31.5 L39.5 40.5"
        stroke="currentColor"
        strokeWidth={2.25}
        strokeLinecap="round"
        opacity={0.6}
      />
      <circle cx="22" cy="8" r="3.5" fill="currentColor" />
      <circle cx="34.4" cy="17" r="3.5" fill="currentColor" />
      <circle cx="29.6" cy="31.5" r="3.5" fill="currentColor" />
      <circle cx="14.4" cy="31.5" r="3.5" fill="currentColor" />
      <circle cx="9.6" cy="17" r="3.5" fill="currentColor" />
      <circle cx="39.5" cy="40.5" r="4" fill="currentColor" />
    </svg>
  );
}
