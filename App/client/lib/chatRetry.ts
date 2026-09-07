/** An image-only accepted turn still needs a meaningful request when retried. */
export function chatRetryText(message: {
  content: string;
  attachments?: readonly unknown[];
}): string {
  if (message.content.trim()) return message.content;
  return message.attachments?.length
    ? "Please try again using the files attached to my previous message."
    : "";
}
