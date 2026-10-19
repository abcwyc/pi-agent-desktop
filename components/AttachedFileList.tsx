"use client";

import { useState } from "react";
import { formatAttachmentSize } from "@/lib/chat-attachments";
import { useI18n } from "@/hooks/useI18n";

/** The files a user attached to a chat message, shown as chips that expand to their text. */
export function AttachedFileList({ files }: { files: readonly { name: string; text: string }[] }) {
  const { t } = useI18n();
  const [openIndex, setOpenIndex] = useState<number | null>(null);

  return (
    <div className="message-attached-files">
      {files.map((file, index) => {
        const open = openIndex === index;
        const size = formatAttachmentSize(new TextEncoder().encode(file.text).length);
        return (
          <div key={`${file.name}-${index}`} className={`message-attached-file${open ? " is-open" : ""}`}>
            <button
              type="button"
              className="message-attached-file-head"
              aria-expanded={open}
              title={open ? t("i18n.collapse") : t("i18n.expand")}
              onClick={() => setOpenIndex(open ? null : index)}
            >
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" />
                <polyline points="14 3 14 8 19 8" />
              </svg>
              <span className="message-attached-file-name">{file.name}</span>
              <span className="message-attached-file-size">{size}</span>
            </button>
            {open && <pre className="message-attached-file-body">{file.text}</pre>}
          </div>
        );
      })}
    </div>
  );
}
