export { JsonCache } from "./cache.js";
export {
  aldenHome,
  backgroundModelAllowed,
  getConfigValue,
  isKnownKey,
  loadConfig,
  queueScope,
  type RankChange,
  repoConfigPath,
  setConfigValue,
  setRankSettings,
  unsetConfigValue,
  userConfigPath,
} from "./config.js";
export {
  addedLines,
  type DiffFile,
  type DiffLine,
  type FileStatus,
  type Hunk,
  parseHunks,
  parseUnifiedDiff,
} from "./diff/parse.js";
export {
  COMMIT_SHA,
  fetchCompareDiff,
  fetchPullRequestDiff,
  fromRestFile,
  type LocalDiff,
  readLocalDiff,
} from "./diff/sources.js";
export { DiffCache, localDiffView, pullRequestDiffView, toDiffView, toDiffViewFile } from "./diff/view.js";
export { embeddedFile, embeddedFilesUnder, isStandaloneBinary, registerEmbeddedFiles } from "./embedded.js";
export {
  FeedbackLog,
  feedbackItemKey,
  recordReviewSignals,
  redactFeedback,
  signalCounts,
  summarizeFeedback,
} from "./feedback/log.js";
export * from "./follow-ups/index.js";
export * from "./github/index.js";
export {
  type ChangedSymbol,
  changedNewLines,
  changedSymbols,
  loadChangeSymbols,
  type SymbolChange,
} from "./graph/changes.js";
export {
  type Checkout,
  type CheckoutOptions,
  checkoutPullRequest,
  type GraphFrom,
  repoFromRemote,
} from "./graph/checkout.js";
export {
  type Clone,
  type CloneFound,
  cloneAt,
  clonesUnder,
  expandHome,
  findClone,
  noteClone,
  rememberClone,
  rememberedClone,
} from "./graph/clones.js";
export {
  type Definition,
  type DefinitionKind,
  extractSymbols,
  type FileSymbols,
  type ImportBinding,
  type Reference,
} from "./graph/extract.js";
export { EXTRACTOR_VERSION, type IndexOptions, indexCachePath, indexRepo, type RepoIndex } from "./graph/index-repo.js";
export { type GraphLanguage, grammarPath, languageOf, parserFor } from "./graph/parser.js";
export { type CallSite, CodeGraph, type SymbolRef } from "./graph/query.js";
export { createResolver, loadResolverConfig, type Resolver, type ResolverConfig } from "./graph/resolve.js";
export { AI_AGENT_LOGINS, type AuthorKind, authorName, prAuthor } from "./learn/authors.js";
export {
  addNote,
  type CheckLesson,
  type CheckTally,
  checkEvidence,
  checkLesson,
  checkName,
  checkProgress,
  checkReason,
  checkTopic,
  codeArea,
  describeFeature,
  editNote,
  forget,
  forgetAll,
  formatWeight,
  type Learning,
  type LessonWeights,
  learn,
  loadLearning,
  memoryItems,
  memoryRepos,
  neverQuietened,
  noteArea,
  notePath,
  prFeatures,
  type QueueLesson,
  type QueueRow,
  type QueueTally,
  queueBoost,
  quietenedReason,
  reactionProgress,
  recordOpen,
  recordReaction,
  restore,
  reviewProgress,
  scopeNote,
  setLearning,
} from "./learn/learn.js";
export { recordSeen, SEEN_KEEP_DAYS, SEEN_KEEP_PRS, type SeenPlace, seenPlaces } from "./learn/seen.js";
export { AnthropicProvider, type MessagesClient, supportsEffort, toLlmError } from "./llm/anthropic.js";
export {
  affordableInputTokens,
  type BudgetDecision,
  type BudgetLimits,
  checkBudget,
  estimateTokens,
} from "./llm/budget.js";
export { BudgetExceededError, type BudgetedOptions, type BudgetedResult, budgetedGenerate } from "./llm/budgeted.js";
export {
  checkModelKey,
  type ModelKey,
  type ModelKeyDeps,
  type ModelKeySource,
  modelKeyStore,
  resolveModelKey,
} from "./llm/key.js";
export { localDay, type SpendEntry, SpendLedger } from "./llm/ledger.js";
export {
  detectOllama,
  isLocalModelName,
  LOCAL_MODEL_TABLE,
  OLLAMA_URL,
  ollamaUrl,
  type PullProgress,
  pullOllamaModel,
  recommendLocalModel,
  useLocalModel,
} from "./llm/local.js";
export {
  costUsd,
  MODEL_ALIASES,
  NO_USAGE,
  PRICES,
  priceFor,
  resolveModel,
  type TokenUsage,
  worstCaseUsd,
} from "./llm/models.js";
export { DEFAULT_BASE_URL, OpenAICompatibleProvider } from "./llm/openai-compatible.js";
export { createPlatformClient, type Platform, platformModelId } from "./llm/platforms.js";
export {
  type Effort,
  type GenerateRequest,
  type GenerateResult,
  LlmError,
  type LlmErrorKind,
  type LlmProvider,
  type StopReason,
} from "./llm/provider.js";
export { type ProviderChoice, selectProvider } from "./llm/select.js";
export {
  ALDEN_CLOUD_URL,
  ANTHROPIC_KEYS_URL,
  KEY_TEST_MODEL,
  type KeySetupDeps,
  type KeyTestClient,
  modelSetupState,
  OLLAMA_DOWNLOAD_URL,
  type SetupStateDeps,
  setUpModelKey,
  testModelKey,
  useAnthropic,
} from "./llm/setup.js";
export { type MajorBump, majorBumps } from "./queue/bumps.js";
export { type FileKind, fileKind, isLockfile, isPatchBumpTitle, sensitiveMatcher } from "./queue/files.js";
export {
  type FastTrackKind,
  formatAge,
  type Lane,
  queueRows,
  type RankedPullRequest,
  type RankedQueue,
  rankPullRequest,
  rankQueue,
  reviewableSize,
  type Score,
} from "./queue/rank.js";
export { followUpOf, isRereview, REREVIEW_REASON } from "./queue/rereview.js";
export { applyRules, describeWhen, pathGlobs, ruleMatches, ruleReason } from "./queue/rules.js";
export {
  type AldenDraftsMade,
  aldenDraftsLine,
  dropAldenDrafts,
  injectionFlagged,
  keepAldenDrafts,
  MAX_ALDEN_DRAFTS,
  MODEL_CHECK,
  makeAldenDrafts,
} from "./review/auto-drafts.js";
export { buildBriefing, NOT_CHECKED, runChecks } from "./review/briefing.js";
export {
  CHECKS,
  callersCheck,
  ciCheck,
  configCheck,
  dependenciesCheck,
  migrationsCheck,
  secretsCheck,
  sensitivePathsCheck,
  signaturesCheck,
  testsCheck,
} from "./review/checks.js";
export {
  type Dependency,
  type DependencyChange,
  type DependencyGroup,
  diffDependencies,
  isMajorChange,
  isManifest,
  type ManifestSnapshot,
  parseManifest,
} from "./review/dependencies.js";
export {
  briefingForDrafting,
  DRAFT_REVIEW_SYSTEM,
  DraftingError,
  type DraftPlace,
  type DraftReviewOptions,
  type DraftReviewResult,
  draftPlaces,
  draftReview,
  draftReviewPrompt,
  fence,
  hasCommentNear,
  INJECTED_DRAFTING_NOTE,
  MAX_REVIEW_DRAFTS,
  rememberForDrafting,
  SUGGEST_TEXT_SYSTEM,
  type SuggestFor,
  type SuggestTextOptions,
  sentComments,
  suggestCommentText,
  suggestTextPrompt,
  talksToAi,
  usableText,
} from "./review/draft-review.js";
export {
  checkBody,
  checkLinkTarget,
  checkReply,
  checkSendable,
  checkSuggestion,
  checkThread,
  commentableLines,
  commentBody,
  composeReviewBody,
  fetchPullRequestState,
  findAgain,
  findThread,
  isNear,
  isReply,
  type LineAnchor,
  linkText,
  MAX_COMMENT_CHARS,
  NEAR_LINES,
  type Placement,
  placeOnDiff,
  placeOrLink,
  prName,
  publicDraft,
  type ReviewComment,
  ReviewDrafts,
  reviewRequest,
  type SendLearning,
  SendReviewError,
  type SentCounts,
  type Side,
  type StoredDraft,
  sendReview,
  shortThreadId,
  suggestionFence,
  threadWhere,
  unaddressedPlaces,
} from "./review/drafts.js";
export {
  checkFreshness,
  fetchPullRequestNow,
  freshnessOf,
  type PullRequestNow,
} from "./review/freshness.js";
export { buildGraphReview, filesOutsideGraph, type GraphReview } from "./review/graph-context.js";
export { mergeLookHere } from "./review/llm/merge.js";
export {
  type BuiltPrompt,
  buildPrompt,
  DRAFTS_PROMPT,
  type LlmOutput,
  LlmOutputSchema,
  LlmOutputWithDraftsSchema,
  type PromptInput,
  renderFileDiff,
  SYSTEM_PROMPT,
  systemPrompt,
} from "./review/llm/prompt.js";
export { addModelReview, MAX_INPUT_TOKENS, MAX_OUTPUT_TOKENS, type ModelReviewOptions } from "./review/llm/run.js";
export { checkDraft, type ValidatedFindings, validateFindings } from "./review/llm/validate.js";
export { loadLocalManifests, loadPullRequestManifests, reverseApply } from "./review/manifests.js";
export { MAX_LOOK_HERE, pickLookHere, pickWithLearning } from "./review/pick.js";
export { RELATED_CALLERS, RELATED_IMPORTERS, RELATED_TESTS, relatedFiles, withRelated } from "./review/related.js";
export {
  fetchPullRequest,
  type GraphOptions,
  type ReviewStage,
  reviewLocalChanges,
  reviewPullRequest,
  type WithModel,
} from "./review/run.js";
export { findSecrets, mask, redactSecrets, type SecretFinding, shannonEntropy } from "./review/secrets.js";
export {
  type BriefedPlace,
  briefedPlaces,
  confirmNotes,
  learnFromReview,
  noSeenPlaces,
  reviewSignals,
  type SeenReader,
  SIGNAL_WEIGHTS,
  wasSeen,
} from "./review/signals.js";
export { type Declaration, declarationIn, type SignatureChange, signatureChanges } from "./review/signatures.js";
export { type Check, type CheckOutcome, type GraphContext, type ReviewContext, symbolKey } from "./review/types.js";
export {
  addActiveTime,
  closeReviewSession,
  dropReviewSession,
  IDLE_MS,
  MAX_ACTIVE_REPORT_MS,
  noteDrafted,
  noteKept,
  noteModelUsed,
  openReviewSession,
  REVIEW_TIME_HORIZON_HOURS,
  REVIEW_TIME_KEEP_DAYS,
  type ReviewSurface,
  type ReviewTiming,
  reviewTimeStats,
  SESSION_STALE_DAYS,
  TERMINAL_ACTIVE_CAP_MS,
} from "./stats/review-time.js";
export {
  DEFAULT_HORIZON_HOURS,
  distribution,
  fetchPullRequestsOpened,
  type Measured,
  measure,
  repoStats,
  type StatsPullRequest,
  summarizeStats,
  weekOf,
} from "./stats/stats.js";
export { UsageLog } from "./stats/usage.js";
export { AldenStore, closeStores, MIGRATION_COUNT, openStore } from "./store/db.js";
export {
  activeBucket,
  queueEvent,
  reviewEvent,
  reviewTimedEvent,
  signalsEvent,
  statsEvent,
  wallBucket,
} from "./telemetry/events.js";
export {
  type Consent,
  configureTelemetry,
  flushTelemetry,
  installId,
  queuedTelemetry,
  repoHash,
  setTelemetryConsent,
  TELEMETRY_HOST,
  telemetryBlocked,
  telemetryConsent,
  telemetrySurface,
  track,
} from "./telemetry/telemetry.js";
export { checkForUpdate, newerVersion } from "./updates.js";
