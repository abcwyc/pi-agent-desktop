import { DefaultResourceLoader, getAgentDir } from "@earendil-works/pi-coding-agent";
import type { SkillInfo, SkillsResponse } from "@/lib/api-types";
import { annotateSkillsWithInstallInfo } from "@/lib/skill-lock";
import { getProjectTrustStatus, projectTrustReloadOptions } from "@/lib/project-trust";

export async function loadSkillsWithInstallInfo(cwd: string): Promise<SkillsResponse> {
  const agentDir = getAgentDir();
  // Extensions add skills only through `resources_discover` at session_start,
  // which a listing never runs, so loading them here would only import every
  // extension for nothing (#1226).
  const loader = new DefaultResourceLoader({ cwd, agentDir, noExtensions: true });
  await loader.reload(projectTrustReloadOptions(cwd, agentDir));
  const { skills, diagnostics } = loader.getSkills();
  return {
    skills: annotateSkillsWithInstallInfo(skills as SkillInfo[], { cwd, agentDir }),
    diagnostics,
    projectResourcesLoaded: getProjectTrustStatus(cwd, agentDir).trusted,
  };
}
