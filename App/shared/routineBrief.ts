/**
 * The longest brief a Routine may be created with.
 *
 * The create route enforces it and the New routine form stops its brief box at
 * the same length, so the form never hands the server a brief it would refuse.
 * It is the length the routine tools' `brief` and an Initiative's Routine spec
 * already allow.
 */
export const MAX_ROUTINE_BRIEF_LENGTH = 20_000;
