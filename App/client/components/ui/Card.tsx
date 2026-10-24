import React from "react";
import { clsx } from "./clsx";

/**
 * The surface most content sits on: white with a hairline edge and a soft
 * shadow on the slate-50 page; slate-900 on the slate-950 page in dark mode,
 * where a lighter card reads as raised.
 */
export const cardClassName =
  "rounded-xl border border-slate-200 bg-white shadow-sm dark:border-slate-800 dark:bg-slate-900";

export function Card({
  className,
  ...rest
}: React.HTMLAttributes<HTMLDivElement>) {
  return <div {...rest} className={clsx(cardClassName, className)} />;
}

export function CardHeader({
  className,
  ...rest
}: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      {...rest}
      className={clsx("border-b border-slate-100 px-4 py-3 sm:px-5 dark:border-slate-800", className)}
    />
  );
}

export function CardBody({
  className,
  ...rest
}: React.HTMLAttributes<HTMLDivElement>) {
  return <div {...rest} className={clsx("p-4 sm:p-5", className)} />;
}

/** A card's own heading. A level-two heading unless the page says otherwise. */
export function CardTitle({
  as: Heading = "h2",
  className,
  ...rest
}: React.HTMLAttributes<HTMLHeadingElement> & { as?: "h2" | "h3" | "h4" }) {
  return (
    <Heading
      {...rest}
      className={clsx("text-sm font-semibold text-slate-900 dark:text-slate-100", className)}
    />
  );
}

/** The quiet line under a card's title. */
export function CardDescription({
  className,
  ...rest
}: React.HTMLAttributes<HTMLParagraphElement>) {
  return (
    <p {...rest} className={clsx("mt-0.5 text-sm text-slate-500 dark:text-slate-400", className)} />
  );
}
