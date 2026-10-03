"use client";

import { useEffect, useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import type { CodemodePreference } from "@/lib/codemode-settings";
import type { NonChatModelInfo, NonChatModels, NonChatModelType } from "@/lib/nonchat-models";
import {
  ConfigButton,
  ConfigDetailHeader,
  ConfigDetailHeaderInfo,
  ConfigDetailStack,
  ConfigDetailTitle,
  ConfigEmptyState,
  ConfigNotice,
  ConfigSectionTitle,
} from "./SettingsUi";

type NonChatModelsResponse = NonChatModels & { codemode: CodemodePreference };

const SECTION_KEYS: Record<NonChatModelType, { title: string; how: string }> = {
  classifier: { title: "models.nonChatClassifiers", how: "models.nonChatClassifiersHow" },
  image: { title: "models.nonChatImages", how: "models.nonChatImagesHow" },
};

/** Groups rows by provider, keeping the listing's order (signed-in providers first). */
export function groupByProvider(models: NonChatModelInfo[]): Array<{ provider: string; available: boolean; models: NonChatModelInfo[] }> {
  const groups = new Map<string, { provider: string; available: boolean; models: NonChatModelInfo[] }>();
  for (const model of models) {
    const group = groups.get(model.provider) ?? { provider: model.provider, available: false, models: [] };
    group.available ||= model.available;
    group.models.push(model);
    groups.set(model.provider, group);
  }
  return [...groups.values()];
}

const price = (value: number) => `$${Number(value.toPrecision(3))}`;

/**
 * Settings › Models › Classifier & image models. pi lists these models but keeps them out of
 * the model selector: a session reaches them only from codemode scripts, so this pane says
 * which exist, which providers are signed in, and whether Code mode lets sessions call them.
 */
export function NonChatModelsDetail({ onOpenMcp }: { onOpenMcp?: () => void }) {
  const { t } = useI18n();
  const [data, setData] = useState<NonChatModelsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/models/nonchat")
      .then(async (res) => {
        const body = await res.json() as NonChatModelsResponse & { error?: string };
        if (!res.ok || body.error) throw new Error(body.error ?? `HTTP ${res.status}`);
        return body;
      })
      .then((body) => { if (!cancelled) setData(body); })
      .catch((e: unknown) => { if (!cancelled) setError(e instanceof Error ? e.message : String(e)); });
    return () => { cancelled = true; };
  }, []);

  return (
    <ConfigDetailStack className="nonchat-models">
      <ConfigDetailHeader>
        <ConfigDetailHeaderInfo>
          <ConfigDetailTitle>{t("models.nonChatTitle")}</ConfigDetailTitle>
        </ConfigDetailHeaderInfo>
      </ConfigDetailHeader>
      <div className="nonchat-models-intro">{t("models.nonChatIntro")}</div>

      {error && <ConfigEmptyState>{t("models.nonChatLoadFailed", { error })}</ConfigEmptyState>}
      {!data && !error && <ConfigEmptyState>{t("i18n.loading")}</ConfigEmptyState>}

      {data && (
        <>
          <ConfigNotice
            action={onOpenMcp ? (
              <ConfigButton size="small" onClick={onOpenMcp}>{t("models.nonChatOpenCodeMode")}</ConfigButton>
            ) : undefined}
          >
            {t(data.codemode === "always" ? "models.nonChatCodemodeAlways" : "models.nonChatCodemodeAutomatic")}
          </ConfigNotice>

          {(["classifier", "image"] as const).map((type) => (
            <section key={type} className="nonchat-models-section">
              <ConfigSectionTitle>{t(SECTION_KEYS[type].title, { count: data[type].length })}</ConfigSectionTitle>
              <div className="nonchat-models-how">{t(SECTION_KEYS[type].how)}</div>
              {data[type].length === 0 ? (
                <div className="nonchat-models-empty">{t("models.nonChatNone")}</div>
              ) : groupByProvider(data[type]).map((group) => (
                <div key={group.provider} className="nonchat-models-group">
                  <div className="nonchat-models-provider">
                    <span>{group.provider}</span>
                    <span className={`nonchat-models-auth${group.available ? " is-ready" : ""}`}>
                      {t(group.available ? "models.nonChatReady" : "models.nonChatSignIn")}
                    </span>
                  </div>
                  {group.models.map((model) => (
                    <div key={model.id} className="nonchat-models-row">
                      <span className="nonchat-models-name">{model.name}</span>
                      <span className="nonchat-models-id">{model.id}</span>
                      {model.cost && (
                        <span className="nonchat-models-price">
                          {t("models.nonChatPrice", { input: price(model.cost.input), output: price(model.cost.output) })}
                        </span>
                      )}
                    </div>
                  ))}
                </div>
              ))}
            </section>
          ))}
        </>
      )}
    </ConfigDetailStack>
  );
}
