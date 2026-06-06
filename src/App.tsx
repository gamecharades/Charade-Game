import { type CSSProperties, type PointerEvent, useEffect, useMemo, useRef, useState } from "react";
import type { RealtimeChannel } from "@supabase/supabase-js";
import {
  BookOpen,
  Check,
  Clapperboard,
  Clock,
  Copy,
  Image as ImageIcon,
  Link,
  Loader2,
  Mic,
  PenLine,
  Play,
  Plus,
  Radio,
  RefreshCw,
  Shuffle,
  ShieldCheck,
  Square,
  ThumbsDown,
  Trash2,
  Trophy,
  Volume2,
  Users,
  X,
} from "lucide-react";
import {
  CARDS_PER_PACK,
  CATEGORY_PACKS,
  DIFFICULTIES,
  type CategoryId,
  type DifficultyId,
  generateCardPack,
  getCategoryName,
  getDifficultyName,
} from "./cardBank";
import { isSupabaseConfigured, supabase } from "./supabase";

type Phase = "lobby" | "turn-ready" | "acting" | "turn-result" | "game-over";
type TeamId = 1 | 2;
type TurnOutcome = "guessed" | "skipped" | "expired" | "forfeit" | null;
type MediaKind = "image" | "audio" | "drawing";
type ProposalStatus = "delivered" | "invalid";
type ProposalVote = "challenged";

type Team = {
  id: TeamId;
  name: string;
  score: number;
};

type Player = {
  id: string;
  name: string;
  teamId: TeamId;
  isReady: boolean;
  updatedAt: number;
};

type Clue = {
  id: string;
  text: string;
  category: string;
  difficulty?: DifficultyId;
  authorId: string;
};

type MediaProposal = {
  id: string;
  turnId: string;
  kind: MediaKind;
  createdById: string;
  createdByName: string;
  teamId: TeamId;
  clueId: string;
  status: ProposalStatus;
  url: string;
  thumbnail?: string;
  title?: string;
  source?: string;
  searchQuery?: string;
  createdAt: number;
  votes: Record<string, ProposalVote>;
};

type ImageResult = {
  title: string;
  url: string;
  thumbnail: string;
  source?: string;
  context?: string;
};

type RoomState = {
  roomCode: string;
  revision: number;
  hostId: string;
  teams: [Team, Team];
  players: Player[];
  phase: Phase;
  turnSeconds: number;
  winningScore: number;
  selectedCategory: CategoryId | null;
  selectedDifficulty: DifficultyId | null;
  clues: Clue[];
  deck: Clue[];
  currentTeamIndex: number;
  currentActorId: string | null;
  currentClue: Clue | null;
  turnStartedAt: number | null;
  turnOutcome: TurnOutcome;
  mediaProposals: MediaProposal[];
  lastResult: {
    clue: Clue;
    teamName: string;
    outcome: Exclude<TurnOutcome, null>;
  } | null;
};

type RoomSettings = {
  teams: [Team, Team];
  turnSeconds: number;
  winningScore: number;
  selectedCategory: CategoryId;
  selectedDifficulty: DifficultyId;
};

type BroadcastPayload =
  | { type: "state-sync"; state: RoomState; targetId?: string }
  | { type: "state-request"; player: Player }
  | { type: "game-started"; state: RoomState }
  | { type: "player-updated"; player: Player }
  | { type: "proposal-created"; proposal: MediaProposal }
  | { type: "proposal-voted"; proposalId: string; playerId: string }
  | { type: "host-action"; action: "start-game" | "begin-turn" | "next-turn" | "reset-game" }
  | { type: "finish-turn"; outcome: Exclude<TurnOutcome, null> };

const defaultTeams: [Team, Team] = [
  { id: 1, name: "Team Moonshot", score: 0 },
  { id: 2, name: "Team High Five", score: 0 },
];

function cloneTeams(teams: [Team, Team]) {
  return teams.map((team) => ({ ...team })) as [Team, Team];
}

function makeDefaultSettings(): RoomSettings {
  return {
    teams: cloneTeams(defaultTeams),
    turnSeconds: 90,
    winningScore: 7,
    selectedCategory: CATEGORY_PACKS[0].id,
    selectedDifficulty: "normal",
  };
}

function makeId() {
  return crypto.randomUUID?.() ?? `${Date.now()}-${Math.random()}`;
}

function getStoredPlayerId() {
  const stored = sessionStorage.getItem("charades-player-id");
  if (stored) {
    return stored;
  }
  const id = makeId();
  sessionStorage.setItem("charades-player-id", id);
  return id;
}

function makeRoomCode() {
  return Math.random().toString(36).slice(2, 8).toUpperCase();
}

function shuffleClues(clues: Clue[]) {
  return [...clues].sort(() => Math.random() - 0.5);
}

function makeRoomState(roomCode: string, host: Player, settings: RoomSettings = makeDefaultSettings()): RoomState {
  return {
    roomCode,
    revision: 1,
    hostId: host.id,
    teams: cloneTeams(settings.teams),
    players: [host],
    phase: "lobby",
    turnSeconds: settings.turnSeconds,
    winningScore: settings.winningScore,
    selectedCategory: settings.selectedCategory,
    selectedDifficulty: settings.selectedDifficulty,
    clues: [],
    deck: [],
    currentTeamIndex: 0,
    currentActorId: null,
    currentClue: null,
    turnStartedAt: null,
    turnOutcome: null,
    mediaProposals: [],
    lastResult: null,
  };
}

function upsertPlayer(players: Player[], player: Player) {
  const nextPlayers = players.some((item) => item.id === player.id)
    ? players.map((item) => (item.id === player.id ? mergePlayer(item, player) : item))
    : [...players, player];
  return autoAssignTeams(nextPlayers);
}

function addPlayerToRoom(players: Player[], player: Player) {
  if (players.some((item) => item.id === player.id)) {
    return resetReadyIfTeamsUnbalanced(
      autoAssignTeams(updatePlayer(players, player.id, (existing) => mergePlayer(existing, player))),
    );
  }
  return resetReadyIfTeamsUnbalanced(autoAssignTeams([...players, { ...player, isReady: false }]));
}

function mergePlayer(existing: Player, incoming: Player) {
  if ((incoming.updatedAt ?? 0) < (existing.updatedAt ?? 0)) {
    return existing;
  }
  return {
    ...existing,
    name: incoming.name,
    isReady: incoming.isReady,
    updatedAt: incoming.updatedAt,
  };
}

function autoAssignTeams(players: Player[]) {
  return players.map((player, index) => {
    const teamId: TeamId = index % 2 === 0 ? 1 : 2;
    return { ...player, teamId };
  });
}

function updatePlayer(
  players: Player[],
  playerId: string,
  updater: (player: Player) => Player,
) {
  return players.map((player) => (player.id === playerId ? updater(player) : player));
}

function selectActor(players: Player[], teamId: TeamId, previousActorId: string | null) {
  const teamPlayers = players.filter((player) => player.teamId === teamId);
  if (teamPlayers.length === 0) {
    return null;
  }
  const previousIndex = teamPlayers.findIndex((player) => player.id === previousActorId);
  return teamPlayers[(previousIndex + 1 + teamPlayers.length) % teamPlayers.length].id;
}

function getCounts(players: Player[]) {
  return {
    teamOne: players.filter((player) => player.teamId === 1).length,
    teamTwo: players.filter((player) => player.teamId === 2).length,
  };
}

function teamsAreReadyBalanced(players: Player[]) {
  const counts = getCounts(players);
  return counts.teamOne === 2 && counts.teamTwo === 2;
}

function resetReadyIfTeamsUnbalanced(players: Player[]) {
  if (teamsAreReadyBalanced(players) || players.every((player) => !player.isReady)) {
    return players;
  }
  return players.map((player) => ({ ...player, isReady: false }));
}

function getTurnId(state: RoomState) {
  return `${state.roomCode}:${state.currentClue?.id ?? "none"}:${state.turnStartedAt ?? "ready"}`;
}

function applyProposalChallenge(
  state: RoomState,
  proposalId: string,
  playerId: string,
): RoomState {
  const activeTeamId = state.teams[state.currentTeamIndex].id;
  const reviewerIds = state.players
    .filter((player) => player.teamId !== activeTeamId)
    .map((player) => player.id);

  let becameInvalid = false;
  let challengedProposal: MediaProposal | null = null;

  const mediaProposals = state.mediaProposals.map((proposal) => {
    if (proposal.id !== proposalId || proposal.status !== "delivered") {
      return proposal;
    }
    const votes = { ...proposal.votes, [playerId]: "challenged" as const };
    const isInvalid =
      reviewerIds.length > 0 && reviewerIds.every((id) => votes[id] === "challenged");
    const status: ProposalStatus = isInvalid ? "invalid" : proposal.status;
    const updatedProposal: MediaProposal = { ...proposal, votes, status };
    if (isInvalid) {
      becameInvalid = true;
      challengedProposal = updatedProposal;
    }
    return updatedProposal;
  });

  if (!becameInvalid || !state.currentClue || !challengedProposal) {
    return { ...state, mediaProposals };
  }

  return {
    ...state,
    mediaProposals,
    phase: "turn-result",
    turnOutcome: "forfeit",
    turnStartedAt: null,
    lastResult: {
      clue: state.currentClue,
      teamName: state.teams[state.currentTeamIndex].name,
      outcome: "forfeit",
    },
  };
}

function blobToDataUrl(blob: Blob) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

export function App() {
  const channelRef = useRef<RealtimeChannel | null>(null);
  const stateRef = useRef<RoomState | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
  const autoJoinAttemptedRef = useRef(false);
  const playerId = useMemo(getStoredPlayerId, []);
  const urlRoomCode = useMemo(
    () => new URLSearchParams(window.location.search).get("room")?.trim().toUpperCase() ?? "",
    [],
  );
  const [playerName, setPlayerName] = useState(localStorage.getItem("charades-player-name") ?? "");
  const [playerUpdatedAt, setPlayerUpdatedAt] = useState(Date.now());
  const [teamId, setTeamId] = useState<TeamId>(1);
  const [isReady, setIsReady] = useState(false);
  const [draftSettings, setDraftSettings] = useState<RoomSettings>(() => makeDefaultSettings());
  const [roomInput, setRoomInput] = useState("");
  const [roomState, setRoomState] = useState<RoomState | null>(null);
  const [connectionStatus, setConnectionStatus] = useState("Offline setup");
  const [imageQuery, setImageQuery] = useState("");
  const [imageResults, setImageResults] = useState<ImageResult[]>([]);
  const [imageSearchStatus, setImageSearchStatus] = useState("");
  const [recordingStatus, setRecordingStatus] = useState("");
  const [isRecording, setIsRecording] = useState(false);
  const [now, setNow] = useState(Date.now());

  const player = useMemo<Player>(
    () => ({
      id: playerId,
      name: playerName.trim() || "Player",
      teamId,
      isReady,
      updatedAt: playerUpdatedAt,
    }),
    [playerId, playerName, teamId, isReady, playerUpdatedAt],
  );

  const isHost = roomState?.hostId === playerId;
  const activeTeam = roomState?.teams[roomState.currentTeamIndex];
  const currentActor = roomState?.players.find((item) => item.id === roomState.currentActorId) ?? null;
  const localPlayer = roomState?.players.find((item) => item.id === playerId);
  const canControlTurn = isHost || roomState?.currentActorId === playerId;
  const shareUrl = roomState
    ? `${window.location.origin}${window.location.pathname}?room=${roomState.roomCode}`
    : "";
  const counts = roomState ? getCounts(roomState.players) : { teamOne: 0, teamTwo: 0 };
  const teamsReadyBalanced = roomState ? teamsAreReadyBalanced(roomState.players) : false;
  const readyCounts = roomState
    ? {
        teamOne: roomState.players.filter((item) => item.teamId === 1 && item.isReady).length,
        teamTwo: roomState.players.filter((item) => item.teamId === 2 && item.isReady).length,
      }
    : { teamOne: 0, teamTwo: 0 };
  const secondsLeft =
    roomState?.phase === "acting" && roomState.turnStartedAt
      ? Math.max(0, roomState.turnSeconds - Math.floor((now - roomState.turnStartedAt) / 1000))
      : roomState?.turnSeconds ?? 90;
  const currentTurnId = roomState ? getTurnId(roomState) : "";
  const currentTurnProposals =
    roomState?.mediaProposals.filter((proposal) => proposal.turnId === currentTurnId) ?? [];
  const deliveredProposals = currentTurnProposals.filter((proposal) => proposal.status === "delivered");
  const isActor = roomState?.currentActorId === playerId;
  const isActiveGuesser =
    Boolean(roomState?.phase === "acting" && activeTeam && localPlayer?.teamId === activeTeam.id && !isActor);
  const isReviewer =
    Boolean(roomState?.phase === "acting" && activeTeam && localPlayer?.teamId !== activeTeam.id);
  const leader = useMemo(
    () => (roomState ? [...roomState.teams].sort((a, b) => b.score - a.score)[0] : null),
    [roomState],
  );
  const canStart =
    Boolean(roomState) &&
    roomState!.players.length >= 4 &&
    counts.teamOne === 2 &&
    counts.teamTwo === 2 &&
    readyCounts.teamOne === 2 &&
    readyCounts.teamTwo === 2 &&
    Boolean(roomState!.selectedCategory) &&
    Boolean(roomState!.selectedDifficulty);

  useEffect(() => {
    stateRef.current = roomState;
  }, [roomState]);

  useEffect(() => {
    localStorage.setItem("charades-player-name", playerName);
  }, [playerName]);

  useEffect(() => {
    if (urlRoomCode) {
      setRoomInput(urlRoomCode);
    }
  }, [urlRoomCode]);

  useEffect(() => {
    if (!urlRoomCode || roomState || autoJoinAttemptedRef.current) {
      return;
    }
    autoJoinAttemptedRef.current = true;
    void connect(urlRoomCode, player, false);
  }, [urlRoomCode, roomState, player.id]);

  useEffect(() => {
    const interval = window.setInterval(() => setNow(Date.now()), 500);
    return () => window.clearInterval(interval);
  }, []);

  useEffect(() => {
    if (!roomState || !isHost) {
      return;
    }
    const interval = window.setInterval(() => {
      const current = stateRef.current;
      if (current) {
        void saveRoomState(current);
        void broadcast({ type: "state-sync", state: current });
      }
    }, 1200);
    return () => window.clearInterval(interval);
  }, [roomState?.roomCode, roomState?.phase, isHost]);

  useEffect(() => {
    if (!roomState || isHost) {
      return;
    }
    const interval = window.setInterval(() => {
      void loadRoomState(roomState.roomCode);
      void broadcast({ type: "state-request", player });
    }, 1500);
    return () => window.clearInterval(interval);
  }, [roomState?.roomCode, roomState?.phase, isHost, player.id, player.updatedAt]);

  useEffect(() => {
    if (roomState?.phase === "acting" && secondsLeft <= 0 && isHost) {
      finishTurn("expired");
    }
  }, [roomState?.phase, secondsLeft, isHost]);

  useEffect(() => {
    if (roomState?.phase === "lobby" && canStart && isHost) {
      startGame();
    }
  }, [roomState?.phase, canStart, isHost]);

  useEffect(() => {
    if (!roomState || !localPlayer) {
      return;
    }
    if (localPlayer.name === player.name && localPlayer.teamId === player.teamId) {
      if (localPlayer.isReady === player.isReady) {
        return;
      }
    }
    broadcast({ type: "player-updated", player });
    if (isHost) {
      commitState((state) => ({
        ...state,
        players: resetReadyIfTeamsUnbalanced(upsertPlayer(state.players, player)),
      }));
    }
  }, [player.name, player.teamId, player.isReady]);

  function updatePlayerName(name: string) {
    setPlayerName(name);
    setPlayerUpdatedAt(Date.now());
  }

  function toggleReady(ready: boolean) {
    if (ready && (!roomState || !teamsAreReadyBalanced(roomState.players))) {
      return;
    }
    setIsReady(ready);
    setPlayerUpdatedAt(Date.now());
  }

  useEffect(() => {
    if (!roomState || !localPlayer) {
      return;
    }
    if (localPlayer.isReady !== isReady) {
      setIsReady(localPlayer.isReady);
    }
    if (localPlayer.teamId !== teamId) {
      setTeamId(localPlayer.teamId);
    }
  }, [roomState?.players, localPlayer?.id]);

  function setSyncedState(nextState: RoomState, force = false) {
    const current = stateRef.current;
    if (
      !force &&
      current &&
      current.roomCode === nextState.roomCode &&
      nextState.revision < current.revision
    ) {
      return;
    }
    stateRef.current = nextState;
    setRoomState(nextState);
  }

  async function broadcast(payload: BroadcastPayload) {
    if (!channelRef.current) {
      return;
    }
    await channelRef.current.send({ type: "broadcast", event: "game", payload });
  }

  async function saveRoomState(state: RoomState) {
    try {
      await fetch(`/api/rooms/${encodeURIComponent(state.roomCode)}/state`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ state }),
      });
    } catch {
      // Realtime still works locally if the Render state endpoint is unavailable.
    }
  }

  async function loadRoomState(roomCode: string) {
    try {
      const response = await fetch(`/api/rooms/${encodeURIComponent(roomCode)}/state`, {
        cache: "no-store",
      });
      if (!response.ok) {
        return;
      }
      const data = await response.json();
      if (data.state) {
        setSyncedState(data.state);
      }
    } catch {
      // Ignore polling failures; the next tick or realtime message can recover.
    }
  }

  function broadcastStateBurst(state: RoomState, includeGameStarted = false) {
    [0, 300, 900, 1800].forEach((delay) => {
      window.setTimeout(() => {
        void saveRoomState(state);
        void broadcast({ type: "state-sync", state });
        if (includeGameStarted) {
          void broadcast({ type: "game-started", state });
        }
      }, delay);
    });
  }

  function commitState(updater: (state: RoomState) => RoomState) {
    const current = stateRef.current;
    if (!current) {
      return null;
    }
    const nextState = { ...updater(current), revision: current.revision + 1 };
    setSyncedState(nextState);
    void saveRoomState(nextState);
    void broadcast({ type: "state-sync", state: nextState });
    return nextState;
  }

  async function connect(
    roomCode: string,
    nextPlayer: Player,
    asHost: boolean,
    settings: RoomSettings = makeDefaultSettings(),
  ) {
    const cleanCode = roomCode.trim().toUpperCase();
    if (!cleanCode) {
      return;
    }

    channelRef.current?.unsubscribe();
    setConnectionStatus(isSupabaseConfigured ? "Connecting..." : "Local demo mode");

    if (!isSupabaseConfigured || !supabase) {
      setSyncedState(makeRoomState(cleanCode, nextPlayer, settings), true);
      return;
    }

    const channel = supabase.channel(`charades:${cleanCode}`, {
      config: {
        broadcast: { ack: true, self: false },
        presence: { key: playerId },
      },
    });
    channelRef.current = channel;

    channel.on("broadcast", { event: "game" }, ({ payload }: { payload: BroadcastPayload }) => {
      handleBroadcast(payload);
    });
    channel.on("presence", { event: "sync" }, () => {
      setConnectionStatus("Connected");
    });

    channel.subscribe(async (status) => {
      if (status !== "SUBSCRIBED") {
        setConnectionStatus(status);
        return;
      }
      setConnectionStatus("Connected");
      await channel.track({ playerId, name: nextPlayer.name, teamId: nextPlayer.teamId });
      if (asHost) {
        const nextState = makeRoomState(cleanCode, nextPlayer, settings);
        setSyncedState(nextState, true);
        await saveRoomState(nextState);
        await broadcast({ type: "state-sync", state: nextState });
      } else {
        await loadRoomState(cleanCode);
        await broadcast({ type: "state-request", player: nextPlayer });
      }
    });
  }

  function handleBroadcast(payload: BroadcastPayload) {
    const current = stateRef.current;

    if (payload.type === "state-sync") {
      if (!payload.targetId || payload.targetId === playerId) {
        setSyncedState(payload.state);
      }
      return;
    }

    if (payload.type === "game-started") {
      const shouldForceStart = !current || current.phase === "lobby";
      if (shouldForceStart || payload.state.revision >= current.revision) {
        setSyncedState(payload.state, shouldForceStart);
      }
      return;
    }

    if (payload.type === "state-request" && current?.hostId === playerId) {
      if (current.phase !== "lobby") {
        void broadcast({ type: "state-sync", state: current, targetId: payload.player.id });
        return;
      }
      const nextState = commitState((state) => ({ ...state, players: addPlayerToRoom(state.players, payload.player) }));
      if (nextState) {
        void broadcast({ type: "state-sync", state: nextState, targetId: payload.player.id });
      }
      return;
    }

    if (!current || current.hostId !== playerId) {
      return;
    }

    if (payload.type === "player-updated") {
      commitState((state) => ({
        ...state,
        players: resetReadyIfTeamsUnbalanced(upsertPlayer(state.players, payload.player)),
      }));
    }

    if (payload.type === "proposal-created") {
      commitState((state) => ({
        ...state,
        mediaProposals: [payload.proposal, ...state.mediaProposals],
      }));
    }

    if (payload.type === "proposal-voted") {
      commitState((state) => applyProposalChallenge(state, payload.proposalId, payload.playerId));
    }

    if (payload.type === "host-action") {
      if (payload.action === "start-game") {
        startGame();
      }
      if (payload.action === "begin-turn") {
        beginTurn();
      }
      if (payload.action === "next-turn") {
        nextTurn();
      }
      if (payload.action === "reset-game") {
        resetGame();
      }
    }

    if (payload.type === "finish-turn") {
      finishTurn(payload.outcome);
    }
  }

  function createRoom() {
    void connect(makeRoomCode(), player, true, draftSettings);
  }

  function joinRoom() {
    void connect(roomInput, player, false);
  }

  async function searchImages() {
    const query = imageQuery.trim();
    if (!query) {
      return;
    }
    setImageSearchStatus("Searching...");
    setImageResults([]);

    try {
      const response = await fetch(`/api/image-search?q=${encodeURIComponent(query)}`);
      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.error ?? "Image search failed.");
      }
      setImageResults(data.results ?? []);
      setImageSearchStatus(data.results?.length ? "" : "No images found.");
    } catch (error) {
      setImageSearchStatus(error instanceof Error ? error.message : "Image search is unavailable.");
    }
  }

  function submitProposal(proposal: MediaProposal) {
    if (isHost || !isSupabaseConfigured) {
      commitState((state) => ({ ...state, mediaProposals: [proposal, ...state.mediaProposals] }));
      return;
    }
    void broadcast({ type: "proposal-created", proposal });
  }

  function proposeImage(result: ImageResult) {
    if (!roomState || !activeTeam || !roomState.currentClue) {
      return;
    }
    submitProposal({
      id: makeId(),
      turnId: getTurnId(roomState),
      kind: "image",
      createdById: playerId,
      createdByName: player.name,
      teamId: activeTeam.id,
      clueId: roomState.currentClue.id,
      status: "delivered",
      url: result.url,
      thumbnail: result.thumbnail,
      title: result.title,
      source: result.source,
      searchQuery: imageQuery.trim(),
      createdAt: Date.now(),
      votes: {},
    });
    setImageSearchStatus("Sent to guesser.");
  }

  function proposeDrawing(dataUrl: string) {
    if (!roomState || !activeTeam || !roomState.currentClue) {
      return;
    }
    submitProposal({
      id: makeId(),
      turnId: getTurnId(roomState),
      kind: "drawing",
      createdById: playerId,
      createdByName: player.name,
      teamId: activeTeam.id,
      clueId: roomState.currentClue.id,
      status: "delivered",
      url: dataUrl,
      title: "Sketch clue",
      createdAt: Date.now(),
      votes: {},
    });
  }

  async function uploadAudio(blob: Blob, mediaId: string) {
    if (isSupabaseConfigured && supabase && roomState) {
      const path = `rooms/${roomState.roomCode}/${mediaId}.webm`;
      const { error } = await supabase.storage.from("charades-clues").upload(path, blob, {
        contentType: blob.type || "audio/webm",
        upsert: true,
      });
      if (error) {
        throw error;
      }
      const { data } = supabase.storage.from("charades-clues").getPublicUrl(path);
      return data.publicUrl;
    }
    return blobToDataUrl(blob);
  }

  async function proposeAudio(blob: Blob) {
    if (!roomState || !activeTeam || !roomState.currentClue) {
      return;
    }
    const mediaId = makeId();
    setRecordingStatus("Uploading audio...");
    try {
      const url = await uploadAudio(blob, mediaId);
      submitProposal({
        id: mediaId,
        turnId: getTurnId(roomState),
        kind: "audio",
        createdById: playerId,
        createdByName: player.name,
        teamId: activeTeam.id,
        clueId: roomState.currentClue.id,
        status: "delivered",
        url,
        title: "Recorded audio clue",
        createdAt: Date.now(),
        votes: {},
      });
      setRecordingStatus("Sent to guesser.");
    } catch (error) {
      setRecordingStatus(error instanceof Error ? error.message : "Audio upload failed.");
    }
  }

  async function startRecording() {
    if (!navigator.mediaDevices?.getUserMedia) {
      setRecordingStatus("Audio recording is not available in this browser.");
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const recorderOptions: MediaRecorderOptions = { audioBitsPerSecond: 16000 };
      if (MediaRecorder.isTypeSupported("audio/webm;codecs=opus")) {
        recorderOptions.mimeType = "audio/webm;codecs=opus";
      }
      const recorder = new MediaRecorder(stream, recorderOptions);
      audioChunksRef.current = [];
      mediaRecorderRef.current = recorder;
      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) {
          audioChunksRef.current.push(event.data);
        }
      };
      recorder.onstop = () => {
        stream.getTracks().forEach((track) => track.stop());
        const blob = new Blob(audioChunksRef.current, { type: recorder.mimeType || "audio/webm" });
        void proposeAudio(blob);
      };
      recorder.start();
      setIsRecording(true);
      setRecordingStatus("Recording...");
    } catch {
      setRecordingStatus("Microphone permission was blocked.");
    }
  }

  function stopRecording() {
    if (!mediaRecorderRef.current || mediaRecorderRef.current.state === "inactive") {
      return;
    }
    mediaRecorderRef.current.stop();
    setIsRecording(false);
  }

  function challengeProposal(proposalId: string) {
    if (isHost || !isSupabaseConfigured) {
      commitState((state) => applyProposalChallenge(state, proposalId, playerId));
      return;
    }
    void broadcast({ type: "proposal-voted", proposalId, playerId });
  }

  function requestAction(action: "start-game" | "begin-turn" | "next-turn" | "reset-game") {
    if (isHost || !isSupabaseConfigured) {
      if (action === "start-game") startGame();
      if (action === "begin-turn") beginTurn();
      if (action === "next-turn") nextTurn();
      if (action === "reset-game") resetGame();
      return;
    }
    void broadcast({ type: "host-action", action });
  }

  function startGame() {
    const nextState = commitState((state) => {
      const selectedCategory = state.selectedCategory ?? CATEGORY_PACKS[0].id;
      const selectedDifficulty = state.selectedDifficulty ?? "normal";
      const generatedClues = generateCardPack(selectedCategory, selectedDifficulty).map((card) => ({
        id: card.id,
        text: card.text,
        category: `${card.categoryName} - ${getDifficultyName(card.difficulty)}`,
        difficulty: card.difficulty,
        authorId: "card-bank",
      }));
      const deck = shuffleClues([...generatedClues, ...state.clues]);
      const activeTeamId = state.teams[0].id;
      const actorId = selectActor(state.players, activeTeamId, null);
      return {
        ...state,
        teams: state.teams.map((team) => ({ ...team, score: 0 })) as [Team, Team],
        phase: "turn-ready",
        selectedCategory,
        selectedDifficulty,
        deck,
        currentTeamIndex: 0,
        currentActorId: actorId,
        currentClue: deck[0] ?? null,
        turnStartedAt: null,
        turnOutcome: null,
        mediaProposals: [],
        lastResult: null,
      };
    });
    if (nextState) {
      broadcastStateBurst(nextState, true);
    }
  }

  function beginTurn() {
    commitState((state) => ({
      ...state,
      phase: state.currentClue ? "acting" : "game-over",
      turnStartedAt: Date.now(),
      turnOutcome: null,
    }));
  }

  function finishTurn(outcome: Exclude<TurnOutcome, null>) {
    if (!isHost && isSupabaseConfigured) {
      void broadcast({ type: "finish-turn", outcome });
      return;
    }
    commitState((state) => {
      if (!state.currentClue || state.phase === "turn-result") {
        return state;
      }
      const teams = state.teams.map((team, index) =>
        outcome === "guessed" && index === state.currentTeamIndex
          ? { ...team, score: team.score + 1 }
          : team,
      ) as [Team, Team];
      return {
        ...state,
        teams,
        phase: "turn-result",
        turnOutcome: outcome,
        turnStartedAt: null,
        lastResult: {
          clue: state.currentClue,
          teamName: state.teams[state.currentTeamIndex].name,
          outcome,
        },
      };
    });
  }

  function nextTurn() {
    commitState((state) => {
      const remainingDeck = state.currentClue
        ? state.deck.filter((clue) => clue.id !== state.currentClue?.id)
        : state.deck;
      const hasWinner = state.teams.some((team) => team.score >= state.winningScore);
      if (hasWinner || remainingDeck.length === 0) {
        return { ...state, phase: "game-over", deck: remainingDeck, currentClue: null };
      }
      const nextTeamIndex = (state.currentTeamIndex + 1) % state.teams.length;
      const nextTeamId = state.teams[nextTeamIndex].id;
      return {
        ...state,
        phase: "turn-ready",
        deck: remainingDeck,
        currentTeamIndex: nextTeamIndex,
        currentActorId: selectActor(state.players, nextTeamId, state.currentActorId),
        currentClue: remainingDeck[0],
        turnStartedAt: null,
        turnOutcome: null,
      };
    });
  }

  function resetGame() {
    commitState((state) => ({
      ...state,
      phase: "lobby",
      teams: state.teams.map((team) => ({ ...team, score: 0 })) as [Team, Team],
      selectedCategory: state.selectedCategory ?? CATEGORY_PACKS[0].id,
      selectedDifficulty: state.selectedDifficulty ?? "normal",
      deck: [],
      currentTeamIndex: 0,
      currentActorId: null,
      currentClue: null,
      turnStartedAt: null,
      turnOutcome: null,
      mediaProposals: [],
      lastResult: null,
    }));
  }

  function updateDraftTeamName(id: TeamId, name: string) {
    setDraftSettings((settings) => ({
      ...settings,
      teams: settings.teams.map((team) => (team.id === id ? { ...team, name } : team)) as [Team, Team],
    }));
  }

  function updateDraftSetting(key: "turnSeconds" | "winningScore", value: number) {
    setDraftSettings((settings) => ({ ...settings, [key]: value }));
  }

  function updateDraftDifficulty(difficulty: DifficultyId) {
    setDraftSettings((settings) => ({ ...settings, selectedDifficulty: difficulty }));
  }

  function updateDraftCategory(category: CategoryId) {
    setDraftSettings((settings) => ({ ...settings, selectedCategory: category }));
  }

  async function copyInvite() {
    if (!shareUrl) {
      return;
    }
    await navigator.clipboard.writeText(`${shareUrl}\nRoom code: ${roomState?.roomCode}`);
  }

  return (
    <main className="app-shell">
      <section className="game-surface">
        <header className="topbar">
          <div className="brand-mark">
            <Clapperboard aria-hidden="true" size={24} />
          </div>
          <div>
            <p className="eyebrow">{roomState ? `Room ${roomState.roomCode}` : "Online party room"}</p>
            <h1>Charades</h1>
          </div>
          <span className="connection-badge">
            <Radio size={14} />
            {connectionStatus}
          </span>
        </header>

        {!roomState && (
          <section className="screen setup-screen">
            <div className="panel">
              <div className="panel-heading">
                <h2>Your player</h2>
                <span>{isSupabaseConfigured ? "Supabase ready" : "Add Supabase env for online play"}</span>
              </div>
              <label className="field-label">
                Name
                <input
                  value={playerName}
                  placeholder="Your name"
                  onChange={(event) => updatePlayerName(event.target.value)}
                />
              </label>
            </div>

            <div className="settings-grid host-settings">
              <label className="setting-card">
                <BookOpen size={18} />
                <span>Field</span>
                <select
                  value={draftSettings.selectedCategory}
                  onChange={(event) => updateDraftCategory(event.target.value as CategoryId)}
                >
                  {CATEGORY_PACKS.map((category) => (
                    <option value={category.id} key={category.id}>
                      {category.name}
                    </option>
                  ))}
                </select>
              </label>
              <label className="setting-card">
                <Shuffle size={18} />
                <span>Difficulty</span>
                <select
                  value={draftSettings.selectedDifficulty}
                  onChange={(event) => updateDraftDifficulty(event.target.value as DifficultyId)}
                >
                  {DIFFICULTIES.map((difficulty) => (
                    <option value={difficulty.id} key={difficulty.id}>
                      {difficulty.name}
                    </option>
                  ))}
                </select>
              </label>
              {draftSettings.teams.map((team) => (
                <label className="setting-card" key={team.id}>
                  <Users size={18} />
                  <span>Team {team.id} name</span>
                  <input
                    value={team.name}
                    onChange={(event) => updateDraftTeamName(team.id, event.target.value)}
                  />
                </label>
              ))}
              <label className="setting-card">
                <Clock size={18} />
                <span>Turn timer</span>
                <select
                  value={draftSettings.turnSeconds}
                  onChange={(event) => updateDraftSetting("turnSeconds", Number(event.target.value))}
                >
                  <option value={60}>1 minute</option>
                  <option value={90}>1.5 minutes</option>
                  <option value={120}>2 minutes</option>
                </select>
              </label>
              <label className="setting-card">
                <Trophy size={18} />
                <span>Winning score</span>
                <input
                  type="number"
                  min={3}
                  max={30}
                  value={draftSettings.winningScore}
                  onChange={(event) => updateDraftSetting("winningScore", Number(event.target.value))}
                />
              </label>
            </div>

            <div className="action-stack">
              <button className="primary-button" type="button" onClick={createRoom}>
                <Plus size={18} />
                Create room
              </button>
              <div className="join-row">
                <input
                  value={roomInput}
                  placeholder="Room code"
                  onChange={(event) => setRoomInput(event.target.value.toUpperCase())}
                />
                <button className="secondary-button" type="button" onClick={joinRoom}>
                  <Link size={18} />
                  Join
                </button>
              </div>
            </div>
          </section>
        )}

        {roomState?.phase === "lobby" && (
          <section className="screen setup-screen">
            <RoomHeader roomState={roomState} shareUrl={shareUrl} copyInvite={copyInvite} />

            {roomState.selectedCategory && roomState.selectedDifficulty && (
              <PackBanner categoryId={roomState.selectedCategory} difficulty={roomState.selectedDifficulty} />
            )}

            <TeamReadyPanel
              teams={roomState.teams}
              players={roomState.players}
              localPlayerId={playerId}
              localPlayerName={playerName}
              setLocalPlayerName={updatePlayerName}
              toggleReady={toggleReady}
              canReady={teamsReadyBalanced}
            />
          </section>
        )}

        {roomState?.phase === "turn-ready" && activeTeam && (
          <section className="screen turn-ready">
            {roomState.selectedCategory && roomState.selectedDifficulty && (
              <PackBanner categoryId={roomState.selectedCategory} difficulty={roomState.selectedDifficulty} />
            )}
            <Scoreboard teams={roomState.teams} activeTeamId={activeTeam.id} />
            <article className={roomState.currentActorId === playerId ? "secret-card" : "waiting-card"}>
              <p className="eyebrow">{roomState.currentActorId === playerId ? "You are acting" : "Actor is choosing"}</p>
              <h2>{roomState.currentActorId === playerId ? roomState.currentClue?.text : currentActor?.name ?? "Actor"}</h2>
              <span>{roomState.currentActorId === playerId ? roomState.currentClue?.category : activeTeam.name}</span>
            </article>
            <p className="handoff">
              {roomState.currentActorId === playerId
                ? "Memorize the clue. When you start, act silently while your teammate guesses."
                : `${currentActor?.name ?? "The actor"} is up for ${activeTeam.name}.`}
            </p>
            <button
              className="primary-button"
              type="button"
              onClick={() => requestAction("begin-turn")}
              disabled={!canControlTurn}
            >
              <Play size={18} />
              Start acting
            </button>
          </section>
        )}

        {roomState?.phase === "acting" && activeTeam && (
          <section className="screen acting-screen">
            {roomState.selectedCategory && roomState.selectedDifficulty && (
              <PackBanner categoryId={roomState.selectedCategory} difficulty={roomState.selectedDifficulty} />
            )}
            <div className="timer-ring" style={{ "--progress": secondsLeft / roomState.turnSeconds } as CSSProperties}>
              <span>{secondsLeft}</span>
              <small>seconds</small>
            </div>
            <div className="prompt-lockup">
              <p>{activeTeam.name}</p>
              <h2>{roomState.currentActorId === playerId ? roomState.currentClue?.text : currentActor?.name}</h2>
              <span>
                {roomState.currentActorId === playerId
                  ? roomState.currentClue?.category
                  : localPlayer?.teamId === activeTeam.id
                    ? "Guess out loud"
                    : "Watch quietly"}
              </span>
            </div>
            {isActor && (
              <ActorCluePanel
                imageQuery={imageQuery}
                imageResults={imageResults}
                imageSearchStatus={imageSearchStatus}
                isRecording={isRecording}
                recordingStatus={recordingStatus}
                setImageQuery={setImageQuery}
                searchImages={searchImages}
                proposeImage={proposeImage}
                proposeDrawing={proposeDrawing}
                startRecording={startRecording}
                stopRecording={stopRecording}
                clueCount={deliveredProposals.length}
              />
            )}
            {isReviewer && roomState.currentClue && (
              <ChallengePanel
                answer={roomState.currentClue.text}
                proposals={deliveredProposals}
                playerId={playerId}
                challengeProposal={challengeProposal}
              />
            )}
            {isActiveGuesser && <DeliveredClues proposals={deliveredProposals} />}
            <div className="turn-controls">
              <button className="success-button" type="button" onClick={() => finishTurn("guessed")} disabled={!canControlTurn}>
                <Check size={22} />
                Guessed
              </button>
              <button className="danger-button" type="button" onClick={() => finishTurn("skipped")} disabled={!canControlTurn}>
                <X size={22} />
                No point
              </button>
            </div>
          </section>
        )}

        {roomState?.phase === "turn-result" && roomState.lastResult && (
          <section className="screen result-screen">
            <Scoreboard teams={roomState.teams} activeTeamId={activeTeam?.id ?? 1} />
            <article className={`result-card ${roomState.lastResult.outcome}`}>
              <span>
                {roomState.lastResult.outcome === "guessed"
                  ? "Point scored"
                  : roomState.lastResult.outcome === "expired"
                    ? "Time expired"
                    : roomState.lastResult.outcome === "forfeit"
                      ? "Clue challenged"
                    : "No point"}
              </span>
              <h2>{roomState.lastResult.clue.text}</h2>
              <p>{roomState.lastResult.teamName}</p>
            </article>
            <button className="primary-button" type="button" onClick={() => requestAction("next-turn")} disabled={!isHost}>
              Next turn
            </button>
          </section>
        )}

        {roomState?.phase === "game-over" && leader && (
          <section className="screen result-screen">
            <article className="winner-card">
              <Trophy size={36} />
              <p>Game over</p>
              <h2>{leader.name} wins</h2>
              <span>{leader.score} points</span>
            </article>
            <Scoreboard teams={roomState.teams} activeTeamId={leader.id} />
            <button className="primary-button" type="button" onClick={() => requestAction("reset-game")} disabled={!isHost}>
              <RefreshCw size={18} />
              Back to lobby
            </button>
          </section>
        )}
      </section>
    </main>
  );
}

function RoomHeader({
  roomState,
  shareUrl,
  copyInvite,
}: {
  roomState: RoomState;
  shareUrl: string;
  copyInvite: () => void;
}) {
  return (
    <div className="room-banner">
      <div>
        <p className="eyebrow">Invite friends</p>
        <h2>{roomState.roomCode}</h2>
        <span>{shareUrl}</span>
      </div>
      <button className="icon-button muted" type="button" onClick={copyInvite} aria-label="Copy invite link">
        <Copy size={20} />
      </button>
    </div>
  );
}

function TeamReadyPanel({
  teams,
  players,
  localPlayerId,
  localPlayerName,
  setLocalPlayerName,
  toggleReady,
  canReady,
}: {
  teams: [Team, Team];
  players: Player[];
  localPlayerId: string;
  localPlayerName: string;
  setLocalPlayerName: (name: string) => void;
  toggleReady: (ready: boolean) => void;
  canReady: boolean;
}) {
  const localPlayer = players.find((player) => player.id === localPlayerId);

  return (
    <div className="panel team-ready-panel">
      <div className="panel-heading">
        <h2>Teams</h2>
        <span>{players.length}/4 joined</span>
      </div>
      <label className="field-label">
        Your name
        <input
          value={localPlayerName}
          placeholder="Your name"
          onChange={(event) => setLocalPlayerName(event.target.value)}
        />
      </label>
      <div className="team-ready-grid">
        {teams.map((team) => {
          const teamPlayers = players.filter((player) => player.teamId === team.id);
          const hasLocalPlayer = teamPlayers.some((player) => player.id === localPlayerId);
          return (
            <article className={hasLocalPlayer ? "team-ready-card selected" : "team-ready-card"} key={team.id}>
              <div className="team-ready-header">
                <strong>{team.name}</strong>
                <span>{hasLocalPlayer ? `Your team - ${teamPlayers.length}/2` : `${teamPlayers.length}/2`}</span>
              </div>
              <div className="team-roster">
                {teamPlayers.map((player) => (
                  <label className="ready-row" key={player.id}>
                    <span>{player.name}</span>
                    {player.id === localPlayerId ? (
                      <input
                        type="checkbox"
                        checked={Boolean(localPlayer?.isReady)}
                        onChange={(event) => toggleReady(event.target.checked)}
                        disabled={!canReady}
                        aria-label="Ready"
                      />
                    ) : (
                      <input type="checkbox" checked={player.isReady} readOnly aria-label={`${player.name} ready`} />
                    )}
                  </label>
                ))}
                {Array.from({ length: Math.max(0, 2 - teamPlayers.length) }).map((_, index) => (
                  <div className="ready-row empty" key={`${team.id}-empty-${index}`}>
                    <span>Waiting for player</span>
                  </div>
                ))}
              </div>
            </article>
          );
        })}
      </div>
      <p className="status-line">
        {canReady
          ? "Ready is unlocked. Tick your box when you are ready. The game starts automatically when all 4 players are ready."
          : "Teams are assigned automatically. Ready unlocks when 4 players have joined."}
      </p>
    </div>
  );
}

function PackBanner({ categoryId, difficulty }: { categoryId: CategoryId; difficulty: DifficultyId }) {
  return (
    <div className="pack-banner">
      <strong>{getCategoryName(categoryId)}</strong>
      <span>
        {getDifficultyName(difficulty)} - {CARDS_PER_PACK.toLocaleString()} cards
      </span>
    </div>
  );
}

function ActorCluePanel({
  imageQuery,
  imageResults,
  imageSearchStatus,
  isRecording,
  recordingStatus,
  clueCount,
  setImageQuery,
  searchImages,
  proposeImage,
  proposeDrawing,
  startRecording,
  stopRecording,
}: {
  imageQuery: string;
  imageResults: ImageResult[];
  imageSearchStatus: string;
  isRecording: boolean;
  recordingStatus: string;
  clueCount: number;
  setImageQuery: (value: string) => void;
  searchImages: () => void;
  proposeImage: (result: ImageResult) => void;
  proposeDrawing: (dataUrl: string) => void;
  startRecording: () => void;
  stopRecording: () => void;
}) {
  return (
    <div className="panel media-panel">
      <div className="panel-heading">
        <h2>Send clues</h2>
        <span>{clueCount} sent</span>
      </div>
      <div className="media-actions">
        <SketchPad onSend={proposeDrawing} />
        <div className="search-row">
          <input
            value={imageQuery}
            placeholder="Search images"
            onChange={(event) => setImageQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") searchImages();
            }}
          />
          <button className="secondary-button compact" type="button" onClick={searchImages}>
            <ImageIcon size={18} />
            Search
          </button>
        </div>
        {imageSearchStatus && (
          <p className="status-line">
            {imageSearchStatus === "Searching..." && <Loader2 size={14} />}
            {imageSearchStatus}
          </p>
        )}
        {imageResults.length > 0 && (
          <div className="image-results">
            {imageResults.map((result) => (
              <button className="image-result" type="button" key={result.url} onClick={() => proposeImage(result)}>
                <img src={result.thumbnail} alt="" />
                <span>{result.source ?? result.title}</span>
              </button>
            ))}
          </div>
        )}
        <button
          className={isRecording ? "danger-button compact" : "secondary-button compact"}
          type="button"
          onClick={isRecording ? stopRecording : startRecording}
        >
          {isRecording ? <Square size={18} /> : <Mic size={18} />}
          {isRecording ? "Stop recording" : "Record audio clue"}
        </button>
        {recordingStatus && <p className="status-line">{recordingStatus}</p>}
      </div>
    </div>
  );
}

function SketchPad({ onSend }: { onSend: (dataUrl: string) => void }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [isDrawing, setIsDrawing] = useState(false);

  function getPoint(event: PointerEvent<HTMLCanvasElement>) {
    const canvas = canvasRef.current;
    if (!canvas) {
      return { x: 0, y: 0 };
    }
    const rect = canvas.getBoundingClientRect();
    return {
      x: ((event.clientX - rect.left) / rect.width) * canvas.width,
      y: ((event.clientY - rect.top) / rect.height) * canvas.height,
    };
  }

  function beginDrawing(event: PointerEvent<HTMLCanvasElement>) {
    const canvas = canvasRef.current;
    const context = canvas?.getContext("2d");
    if (!canvas || !context) {
      return;
    }
    event.currentTarget.setPointerCapture(event.pointerId);
    const point = getPoint(event);
    context.lineWidth = 7;
    context.lineCap = "round";
    context.lineJoin = "round";
    context.strokeStyle = "#172033";
    context.beginPath();
    context.moveTo(point.x, point.y);
    setIsDrawing(true);
  }

  function draw(event: PointerEvent<HTMLCanvasElement>) {
    if (!isDrawing) {
      return;
    }
    const canvas = canvasRef.current;
    const context = canvas?.getContext("2d");
    if (!canvas || !context) {
      return;
    }
    const point = getPoint(event);
    context.lineTo(point.x, point.y);
    context.stroke();
  }

  function endDrawing(event: PointerEvent<HTMLCanvasElement>) {
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    setIsDrawing(false);
  }

  function clearSketch() {
    const canvas = canvasRef.current;
    const context = canvas?.getContext("2d");
    if (!canvas || !context) {
      return;
    }
    context.clearRect(0, 0, canvas.width, canvas.height);
  }

  function sendSketch() {
    const canvas = canvasRef.current;
    if (!canvas) {
      return;
    }
    onSend(canvas.toDataURL("image/png"));
    clearSketch();
  }

  return (
    <div className="sketchpad">
      <canvas
        ref={canvasRef}
        width={640}
        height={360}
        onPointerDown={beginDrawing}
        onPointerMove={draw}
        onPointerUp={endDrawing}
        onPointerCancel={endDrawing}
        aria-label="Draw a clue"
      />
      <div className="sketch-actions">
        <button className="secondary-button compact" type="button" onClick={sendSketch}>
          <PenLine size={18} />
          Send sketch
        </button>
        <button className="small-button" type="button" onClick={clearSketch}>
          <Trash2 size={16} />
          Clear
        </button>
      </div>
    </div>
  );
}

function ChallengePanel({
  answer,
  proposals,
  playerId,
  challengeProposal,
}: {
  answer: string;
  proposals: MediaProposal[];
  playerId: string;
  challengeProposal: (proposalId: string) => void;
}) {
  return (
    <div className="panel media-panel">
      <div className="panel-heading">
        <h2>Challenge clues</h2>
        <span>{proposals.length} sent</span>
      </div>
      <p className="answer-strip">Answer: {answer}</p>
      {proposals.length === 0 ? (
        <p className="status-line">No app clues have been sent yet.</p>
      ) : (
        <div className="proposal-list">
          {proposals.map((proposal) => (
            <article className="proposal-card" key={proposal.id}>
              <MediaPreview proposal={proposal} />
              <div className="proposal-meta">
                <strong>{proposal.createdByName}</strong>
                <span>
                  {proposal.kind === "image"
                    ? proposal.source ?? "Image clue"
                    : proposal.kind === "audio"
                      ? "Audio clue"
                      : "Sketch clue"}
                </span>
              </div>
              <button
                className="danger-button compact"
                type="button"
                onClick={() => challengeProposal(proposal.id)}
                disabled={Boolean(proposal.votes[playerId])}
              >
                <ThumbsDown size={18} />
                Flag unfair clue
              </button>
            </article>
          ))}
        </div>
      )}
    </div>
  );
}

function DeliveredClues({ proposals }: { proposals: MediaProposal[] }) {
  return (
    <div className="panel media-panel">
      <div className="panel-heading">
        <h2>Live clues</h2>
        <span>{proposals.length}</span>
      </div>
      {proposals.length === 0 ? (
        <p className="status-line">No app clues have arrived yet.</p>
      ) : (
        <div className="proposal-list">
          {proposals.map((proposal) => (
            <article className="proposal-card delivered" key={proposal.id}>
              <div className="approved-stamp">
                <ShieldCheck size={18} />
                Sent
              </div>
              <MediaPreview proposal={proposal} />
            </article>
          ))}
        </div>
      )}
    </div>
  );
}

function MediaPreview({ proposal }: { proposal: MediaProposal }) {
  if (proposal.kind === "audio") {
    return (
      <div className="audio-preview">
        <Volume2 size={22} />
        <audio controls src={proposal.url} />
      </div>
    );
  }

  return (
    <a className="image-preview" href={proposal.url} target="_blank" rel="noreferrer">
      <img src={proposal.thumbnail ?? proposal.url} alt={proposal.title ?? "Image clue"} />
    </a>
  );
}

function Scoreboard({ teams, activeTeamId }: { teams: Team[]; activeTeamId: number }) {
  return (
    <div className="scoreboard">
      {teams.map((team) => (
        <article className={team.id === activeTeamId ? "team-score active" : "team-score"} key={team.id}>
          <span>{team.name}</span>
          <strong>{team.score}</strong>
        </article>
      ))}
    </div>
  );
}
