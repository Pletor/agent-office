// Wire protocol between browser and server. Every WebSocket frame is one JSON object.
//
// Each part of the office keeps its state types and its messages in ./protocol/<domain>.ts; this
// file puts them back together, so everything is still imported from here, and makes the two
// unions every frame is one of.

import type { AccountsClientMsg, AccountsServerMsg, SignInsClientMsg, TeamClientMsg } from './protocol/accounts.js';
import type { ChangesClientMsg, ChangesServerMsg } from './protocol/changes.js';
import type { FloorClientMsg, FloorServerMsg, PlanClientMsg } from './protocol/floors.js';
import type { GitHubClientMsg, GitHubServerMsg } from './protocol/github.js';
import type { MeetingClientMsg, MeetingServerMsg } from './protocol/meetings.js';
import type { OporaClientMsg, OporaServerMsg } from './protocol/opora.js';
import type { OrchestratorClientMsg, OrchestratorServerMsg } from './protocol/orchestrator.js';
import type { PlanningClientMsg, PlanningServerMsg } from './protocol/planning.js';
import type { PresenceClientMsg, PresenceServerMsg } from './protocol/presence.js';
import type { ProcessClientMsg, ProcessServerMsg } from './protocol/process.js';
import type { QueueClientMsg, QueueServerMsg } from './protocol/queue.js';
import type { ReaClientMsg, ReaServerMsg } from './protocol/rea.js';
import type { StatusClientMsg, StatusServerMsg } from './protocol/status.js';
import type { RooftopClientMsg, RooftopServerMsg } from './protocol/rooftop.js';
import type { SettingsClientMsg, SettingsServerMsg } from './protocol/settings.js';
import type { BallClientMsg, CabinetClientMsg, CarClientMsg, DecorClientMsg, DogClientMsg, JukeboxClientMsg, ToysServerMsg, WhiteboardClientMsg } from './protocol/toys.js';
import type { UsageClientMsg, UsageServerMsg } from './protocol/usage.js';
import type { WorkerClientMsg, WorkerServerMsg } from './protocol/workers.js';

export * from './protocol/accounts.js';
export * from './protocol/agents.js';
export * from './protocol/changes.js';
export * from './protocol/floors.js';
export * from './protocol/github.js';
export * from './protocol/meetings.js';
export * from './protocol/opora.js';
export * from './protocol/orchestrator.js';
export * from './protocol/planning.js';
export * from './protocol/presence.js';
export * from './protocol/process.js';
export * from './protocol/queue.js';
export * from './protocol/rea.js';
export * from './protocol/status.js';
export * from './protocol/rooftop.js';
export * from './protocol/settings.js';
export * from './protocol/toys.js';
export * from './protocol/usage.js';
export * from './protocol/workers.js';

export type ClientMsg =
  | PresenceClientMsg
  | RooftopClientMsg
  | WorkerClientMsg
  | GitHubClientMsg
  | QueueClientMsg
  | MeetingClientMsg
  | PlanningClientMsg
  | OporaClientMsg
  | OrchestratorClientMsg
  | FloorClientMsg
  | PlanClientMsg
  | ChangesClientMsg
  | TeamClientMsg
  | AccountsClientMsg
  | SignInsClientMsg
  | SettingsClientMsg
  | ReaClientMsg
  | StatusClientMsg
  | UsageClientMsg
  | DecorClientMsg
  | JukeboxClientMsg
  | CabinetClientMsg
  | WhiteboardClientMsg
  | BallClientMsg
  | CarClientMsg
  | DogClientMsg
  | ProcessClientMsg;

export type ServerMsg =
  | PresenceServerMsg
  | RooftopServerMsg
  | WorkerServerMsg
  | GitHubServerMsg
  | QueueServerMsg
  | MeetingServerMsg
  | PlanningServerMsg
  | OporaServerMsg
  | OrchestratorServerMsg
  | FloorServerMsg
  | ChangesServerMsg
  | AccountsServerMsg
  | SettingsServerMsg
  | ReaServerMsg
  | StatusServerMsg
  | UsageServerMsg
  | ToysServerMsg
  | ProcessServerMsg;
