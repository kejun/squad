export function Logo({ compact = false }: { compact?: boolean }) {
  return (
    <div className="brand">
      <img
        className="brand-mark"
        src="/logo.svg"
        width={36}
        height={36}
        alt={compact ? "Squad" : ""}
      />
      {!compact && (
        <span>
          squad<span className="brand-period">.</span>
        </span>
      )}
    </div>
  );
}
