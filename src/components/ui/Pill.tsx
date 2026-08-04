import type {
  AnchorHTMLAttributes,
  ButtonHTMLAttributes,
  ReactNode,
} from "react";

export type PillVariant = "ink" | "card" | "active";

/**
 * Full-radius pill, exactly 3 cells tall (h-12 with --spacing = cell/4),
 * with a 44px floor for small viewports. Focus ring is deliberately
 * square-cornered even though the pill is round (.u-focus-square).
 */
const BASE =
  "u-focus-square inline-flex h-12 min-h-[44px] select-none items-center " +
  "justify-center gap-2 rounded-full px-4 text-[13px] font-semibold " +
  "leading-none whitespace-nowrap";

const VARIANTS: Record<PillVariant, string> = {
  ink: "border-2 border-transparent bg-ink text-paper",
  card: "border-2 border-line bg-card text-ink",
  active: "border-2 border-accent bg-card text-ink",
};

type CommonProps = {
  variant?: PillVariant;
  children: ReactNode;
  className?: string;
};

type ButtonPillProps = CommonProps & {
  href?: undefined;
} & Omit<ButtonHTMLAttributes<HTMLButtonElement>, "className">;

type AnchorPillProps = CommonProps & {
  href: string;
} & Omit<AnchorHTMLAttributes<HTMLAnchorElement>, "className" | "href">;

export type PillProps = ButtonPillProps | AnchorPillProps;

export default function Pill(props: PillProps) {
  const { variant = "card", className } = props;
  const cls = `${BASE} ${VARIANTS[variant]}${className ? ` ${className}` : ""}`;

  if (typeof props.href === "string") {
    const { variant: _v, children, className: _c, ...rest } = props;
    return (
      <a className={cls} {...rest}>
        {children}
      </a>
    );
  }

  const { variant: _v, children, className: _c, href: _h, ...rest } = props;
  return (
    <button type={rest.type ?? "button"} className={cls} {...rest}>
      {children}
    </button>
  );
}
