"use client";

import { useEffect, useState } from "react";
import { useI18n } from "@/hooks/useI18n";

interface Props {
  /** Folder the new session will run in; its last segment names the project. */
  cwd?: string | null;
  /** Chats have no project, so they get the chat subtitle. */
  isChat: boolean;
}

function greetingKey(hour: number): string {
  if (hour < 5) return "welcome.evening";
  if (hour < 12) return "welcome.morning";
  if (hour < 18) return "welcome.afternoon";
  return "welcome.evening";
}

/**
 * Empty new-session state above the centred composer: a greeting, where the
 * session will run. Carries no product branding
 * (the fork removed upstream's icon + name header on purpose).
 */
export function NewSessionWelcome({ cwd, isChat }: Props) {
  const { t } = useI18n();
  // The hour is read after mount so server and client render the same markup.
  const [hour, setHour] = useState<number | null>(null);
  useEffect(() => setHour(new Date().getHours()), []);

  const project = cwd?.split(/[\\/]/).filter(Boolean).pop();

  return (
    <div className="new-session-welcome">
      <h1 className={`new-session-welcome-title${hour === null ? " is-pending" : ""}`}>
        {t(greetingKey(hour ?? 12))}
      </h1>
      <p className="new-session-welcome-subtitle">
        {isChat || !project
          ? t("welcome.subtitleChat")
          : t("welcome.subtitleProject", { project })}
      </p>
    </div>
  );
}
