"use client";

import { useEffect, useRef } from "react";
import { onScheduledTaskEvent, retainScheduledTaskStream } from "@/hooks/useScheduledTasks";
import { useI18n } from "@/hooks/useI18n";
import { notifyDesktop } from "@/lib/desktop-notify";
import { isTauriDesktop } from "@/lib/desktop-updater";
import { describeRunNotification, type RunNotification } from "@/lib/scheduled-tasks/notification-text";

interface Options {
  /** Play the completion sound (a run that went well). */
  onSound: () => void;
  /** Show a notification in a browser tab; the desktop app uses its native one instead. */
  deliverInBrowser: (notification: RunNotification) => void;
}

/**
 * Tell the user how scheduled runs end, from any window that is open. A failed
 * run is reported with its error, a run the user stopped is not reported at all.
 */
export function useScheduledRunNotifications(options: Options): void {
  const { t } = useI18n();
  const latest = useRef({ t, ...options });
  useEffect(() => { latest.current = { t, ...options }; });

  useEffect(() => {
    const release = retainScheduledTaskStream();
    const off = onScheduledTaskEvent((event) => {
      const { t: translate, onSound, deliverInBrowser } = latest.current;
      const notification = describeRunNotification(event, translate);
      if (!notification) return;
      if (notification.sound) onSound();
      if (isTauriDesktop()) void notifyDesktop({ title: notification.title, body: notification.body });
      else deliverInBrowser(notification);
    });
    return () => { off(); release(); };
  }, []);
}
