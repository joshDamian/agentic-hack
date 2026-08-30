export interface DependabotAlert {
  number: number;
  state: string;
  dependency: {
    package: {
      ecosystem: string;
      name: string;
    };
    manifestPath: string;
    scope: string;
  };
  securityAdvisory: {
    ghsaId: string;
    severity: string;
    summary: string;
    description: string;
  };
  securityVulnerability: {
    vulnerableVersionRange: string;
    firstPatchedVersion: string | null;
  };
  createdAt: string;
  fixedAt: string | null;
  autoDismissedAt: string | null;
}

export type BumpVerdict = 'safe' | 'risky' | 'unknown';

export interface PlannedBump {
  packageName: string;
  ecosystem: string;
  currentVersion: string;
  targetVersion: string;
  alertsClosed: number;
  alertNumbers: number[];
  verdict?: BumpVerdict;
  verdictReason?: string;
  breakingChanges?: Array<{
    api: string;
    kind: string;
    description: string;
    migrationHint?: string;
  }>;
  findings?: Array<{
    file: string;
    line: number;
    isAffected: boolean;
    analysis: string;
    originalCode?: string;
    suggestedFix?: string;
  }>;
  prNumber?: number;
  prUrl?: string;
  ciStatus?: 'pending' | 'success' | 'failure' | 'no-checks';
}

export interface Campaign {
  id: string;
  repoOwner: string;
  repoName: string;
  status: 'planning' | 'analysing' | 'executing' | 'monitoring' | 'done' | 'failed';
  plan: PlannedBump[];
  createdAt: string;
  updatedAt: string;
}
