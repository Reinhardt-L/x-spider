import { fs, notification, path } from '@tauri-apps/api';
import { nanoid } from 'nanoid';
import * as R from 'ramda';
import { create } from 'zustand';
import { CreationTask } from '../interfaces/CreationTask';
import { DownloadFilter } from '../interfaces/DownloadFilter';
import { DownloadTask } from '../interfaces/DownloadTask';
import { TwitterMedia } from '../interfaces/TwitterMedia';
import { TwitterPost } from '../interfaces/TwitterPost';
import { TwitterUser } from '../interfaces/TwitterUser';
import { AriaStatus, aria2 } from '../utils/aria2';
import { getUserMedias, getUserTweets } from '../twitter/api';
import { useSettingsStore } from './settings';
import { getDownloadUrl } from '../twitter/utils';
import { resolveVariables } from '../utils/file-name-template';
import { FileNameTemplateData } from '../interfaces/FileNameTemplateData';
import dayjs from 'dayjs';
import { notification as antNotification } from 'antd';

let _log: ICategoriedLogger;

function log() {
  if (_log) return _log;
  _log = window.log.category('DL');
  return _log;
}

export interface CreateDownloadTaskParams {
  post: TwitterPost;
  media: TwitterMedia;
}

async function mergeAriaStatusToDownloadTask(
  ariaStatus: any,
  oldTask: DownloadTask,
  now = Date.now(),
): Promise<DownloadTask> {
  return {
    ...oldTask,
    gid: ariaStatus.gid,
    status: ariaStatus.status,
    completeSize: Number(ariaStatus.completedLength),
    totalSize: Number(ariaStatus.totalLength),
    fileName: await path.basename(ariaStatus.files[0].path),
    error: ariaStatus.errorMessage,
    dir: ariaStatus.dir,
    updatedAt: now,
  };
}

async function prepareDownloadTask({
  post,
  media,
}: CreateDownloadTaskParams): Promise<DownloadTask> {
  const settings = useSettingsStore.getState();
  const downloadUrl = getDownloadUrl(media);
  log().info('downloadUrl', downloadUrl);
  const templateData: FileNameTemplateData = {
    media,
    post,
  };
  const resolvedDirName = settings.download.dirTemplate
    ? resolveVariables(settings.download.dirTemplate, templateData)
    : '';
  log().info('resolved dirName', resolvedDirName);
  const dir = await path.join(settings.download.saveDirBase, resolvedDirName);
  log().info('resolved dir', dir);

  const fileName = resolveVariables(
    settings.download.fileNameTemplate,
    templateData,
  );

  log().info('resolved fileName', fileName);

  const task: DownloadTask = {
    gid: '',
    status: AriaStatus.Waiting,
    completeSize: 0,
    totalSize: Infinity,
    fileName,
    media,
    post,
    error: '',
    dir,
    updatedAt: Date.now(),
    downloadUrl,
    ariaRetryCountRemains: 5,
  };

  return task;
}

const creationTaskAbortControllerMap = new Map<string, AbortController>();

export interface DownloadStore {
  currentTab: string;
  setCurrentTab: (tab: string) => void;

  downloadTasks: DownloadTask[];
  autoSyncTaskIds: string[];
  setAutoSyncTaskIds: (ids: string[]) => void;
  createDownloadTask: (params: CreateDownloadTaskParams) => Promise<void>;
  batchCreateDownloadTask: (
    paramsList: CreateDownloadTaskParams[],
  ) => Promise<void>;
  pauseDownloadTask: (gid: string) => Promise<void>;
  pauseAllDownloadTask: () => Promise<void>;
  unpauseDownloadTask: (gid: string) => Promise<void>;
  unpauseAllDownloadTask: () => Promise<void>;
  removeDownloadTask: (gid: string) => Promise<void>;
  batchRemoveDownloadTasks: (gids: string[]) => Promise<void>;
  syncDownloadTaskStatus: (gid: string) => Promise<void>;
  updateDownloadTask: (task: DownloadTask, now?: number) => void;
  batchUpdateDownloadTasks: (tasks: DownloadTask[]) => void;
  redownloadTask: (gid: string) => Promise<void>;
  batchRedownloadTask: (gid: string[]) => Promise<void>;

  creationTasks: CreationTask[];
  createCreationTask: (user: TwitterUser, filter: DownloadFilter) => void;
  removeCreationTask: (id: string) => void;
  updateCreationTask: (task: CreationTask) => void;
}

export const useDownloadStore = create<DownloadStore>((set, get) => ({
  currentTab: '',
  setCurrentTab: (tab) => set({ currentTab: tab }),

  autoSyncTaskIds: [],
  setAutoSyncTaskIds: (ids) => set({ autoSyncTaskIds: ids }),

  downloadTasks: [],
  createDownloadTask: async (params) => {
    const task = await prepareDownloadTask(params);

    const gid = await aria2.invoke('aria2.addUri', [task.downloadUrl], {
      dir: task.dir,
      out: task.fileName,
    });
    task.gid = gid;

    const status = await aria2.tellStatus(task.gid);
    task.status = status.status;

    set({
      downloadTasks: get().downloadTasks.concat(task),
    });
  },
  updateDownloadTask: (task, now = Date.now()) => {
    const oldTasks = get().downloadTasks;
    const oldTaskIndex = get().downloadTasks.findIndex(
      (t) => t.gid === task.gid,
    );
    if (oldTaskIndex === -1) return;
    const oldTask = oldTasks[oldTaskIndex];
    if (oldTask.updatedAt > now) return;
    const newTasks = R.adjust(oldTaskIndex, R.always(task))(oldTasks);
    set({
      downloadTasks: newTasks,
    });
  },
  batchUpdateDownloadTasks: (tasks) => {
    const { downloadTasks: oldTasks } = get();
    const newTaskMap = R.pipe<
      [DownloadTask[]],
      [DownloadTask['gid'], DownloadTask][],
      Record<string, DownloadTask>
    >(
      R.map((t: DownloadTask) => [t.gid, t]),
      R.fromPairs,
    )(tasks);

    const newTasks = oldTasks.map((oldTask) => {
      const newTask = newTaskMap[oldTask.gid];
      if (!newTask) return oldTask;
      if (newTask.updatedAt < oldTask.updatedAt) {
        return oldTask;
      }
      return newTask;
    });

    set({
      downloadTasks: newTasks,
    });
  },
  batchCreateDownloadTask: async (paramsList) => {
    const tasks: DownloadTask[] = [];

    for (const params of paramsList) {
      const task = await prepareDownloadTask(params);
      tasks.push(task);
    }

    if (tasks.length === 0) {
      return;
    }

    const gids: string[] = (
      await aria2.batchInvoke(
        tasks.map((task) => ({
          methodName: 'aria2.addUri',
          params: [
            [task.downloadUrl],
            {
              dir: task.dir,
              out: task.fileName,
            },
          ],
        })),
      )
    ).flat();

    const statusMap = await aria2.tellStatus(gids);

    tasks.forEach((task, index) => {
      task.gid = gids[index];
      task.status = statusMap[task.gid].status;
    });

    const newTasks = get().downloadTasks.concat(tasks);
    set({
      downloadTasks: newTasks,
    });
  },
  pauseDownloadTask: async (gid) => {
    await aria2.invoke('aria2.pause', gid);
  },
  pauseAllDownloadTask: async () => {
    await aria2.invoke('aria2.pauseAll');
  },
  unpauseDownloadTask: async (gid) => {
    await aria2.invoke('aria2.unpause', gid);
  },
  unpauseAllDownloadTask: async () => {
    await aria2.invoke('aria2.unpauseAll');
  },
  removeDownloadTask: async (gid) => {
    aria2.invoke('aria2.remove', gid).catch((err) => {
      log().warn('Remove aria2 task failed', { gid, err });
    });
    const state = get();
    set({
      downloadTasks: R.filter((v: DownloadTask) => v.gid !== gid)(
        state.downloadTasks,
      ),
      autoSyncTaskIds: R.filter((v: string) => v !== gid)(
        state.autoSyncTaskIds,
      ),
    });
  },
  batchRemoveDownloadTasks: async (gids) => {
    aria2
      .batchInvoke(
        gids.map((gid) => ({
          methodName: 'aria2.remove',
          params: [gid],
        })),
      )
      .catch((err) => {
        log().error({ gids, err });
      });
    set({
      downloadTasks: R.filter((v: DownloadTask) => !gids.includes(v.gid))(
        get().downloadTasks,
      ),
    });
  },
  redownloadTask: async (gid) => {
    const store = get();
    const oldTask = store.downloadTasks.find((t) => t.gid === gid);
    if (!oldTask) {
      throw new Error('找不到旧的下载任务');
    }
    await store.removeDownloadTask(oldTask.gid);
    await store.createDownloadTask({
      post: oldTask.post,
      media: oldTask.media,
    });
  },
  batchRedownloadTask: async (gids) => {
    const store = get();
    const oldTasks = store.downloadTasks.filter((t) => gids.includes(t.gid));
    if (oldTasks.length === 0) {
      throw new Error('找不到旧的下载任务');
    }

    await store.batchRemoveDownloadTasks(gids);
    await store.batchCreateDownloadTask(
      oldTasks.map((task) => ({
        media: task.media,
        post: task.post,
      })),
    );
  },
  syncDownloadTaskStatus: async (gid) => {
    const { downloadTasks, updateDownloadTask, removeDownloadTask } = get();
    const index = downloadTasks.findIndex((v) => v.gid === gid);
    if (index === -1) {
      return;
    }
    const task = downloadTasks[index];
    const now = Date.now();
    const status = await aria2.tellStatus(gid);

    if (status.status === 'error') {
      if (task.ariaRetryCountRemains > 0) {
        log().warn(
          `Task download failed, retry it. RetryCountRemains: ${task.ariaRetryCountRemains}`,
          task,
        );
        removeDownloadTask(task.gid);

        const newTask = await prepareDownloadTask({
          post: task.post,
          media: task.media,
        });
        newTask.ariaRetryCountRemains = task.ariaRetryCountRemains - 1;

        const gid = await aria2.invoke('aria2.addUri', [task.downloadUrl], {
          dir: newTask.dir,
          out: newTask.fileName,
        });
        newTask.gid = gid;

        const status = await aria2.tellStatus(task.gid);
        newTask.status = status.status;

        set({
          downloadTasks: get().downloadTasks.concat(newTask),
        });
      } else {
        const newTask = await mergeAriaStatusToDownloadTask(status, task);
        const msg = '任务下载失败';
        const desc = `${newTask.fileName}\n${newTask.error || '未知原因'}`;
        log().error('Task download failed', newTask);
        antNotification.error({
          message: msg,
          description: desc,
        });
        notification.sendNotification({
          title: msg,
          body: desc,
        });
      }
    } else {
      const newTask = await mergeAriaStatusToDownloadTask(status, task);
      updateDownloadTask(newTask, now);
    }
  },

  creationTasks: [],
  createCreationTask: (user, filter) => {
    const id = nanoid();
    const abortController = new AbortController();
    creationTaskAbortControllerMap.set(id, abortController);
    set({
      creationTasks: [
        ...get().creationTasks,
        {
          id,
          user,
          filter,
          status: 'waiting',
          completeCount: 0,
          skipCount: 0,
        },
      ],
    });
  },
  removeCreationTask: (id) => {
    const abortController = creationTaskAbortControllerMap.get(id);
    if (!abortController) {
      return;
    }
    abortController.abort();
    creationTaskAbortControllerMap.delete(id);
    set({
      creationTasks: get().creationTasks.filter((v) => v.id !== id),
    });
  },
  updateCreationTask: (task) => {
    set({
      creationTasks: get().creationTasks.map((oldTask) => {
        if (oldTask.id === task.id) return task;
        return oldTask;
      }),
    });
  },
}));

async function runCreationTask(task: CreationTask, abortSignal: AbortSignal) {
  log().info('Run creation task', task);
  const { filter, user } = task;

  const { batchCreateDownloadTask, updateCreationTask } =
    useDownloadStore.getState();
  const settings = useSettingsStore.getState();

  let completeCount = 0;
  let skipCount = 0;

  let now = dayjs();
  const since = filter.dateRange?.[0] || dayjs.unix(0);
  const until = filter.dateRange?.[1] || now.clone();
  let nextCursor: string | undefined | null = undefined;

  const getListFn = filter.source === 'medias' ? getUserMedias : getUserTweets;

  const getMediaCounts = R.reduce((acc: number, elem: TwitterPost) => {
    return acc + (elem.medias?.length || 0);
  }, 0);

  while (nextCursor !== null && now.isAfter(since)) {
    if (abortSignal.aborted) {
      return;
    }

    log().info('CreationTask fetching', nextCursor);
    const { twitterPosts, cursor } = await getListFn(user.id, nextCursor);
    if (abortSignal.aborted) break;
    nextCursor = cursor;
    now = R.last(twitterPosts)?.createdAt || now;
    log().info('Now', now.format('YYYY-MM-DD'), 'next cursor', nextCursor);
    const filteredPosts = twitterPosts.filter(
      R.allPass([
        (post) => (post.medias ? post.medias.length >= 0 : false),
        (post) => {
          if (!post.createdAt) return true;
          return until ? post.createdAt.isBefore(until) : true;
        },
        (post) => {
          if (!post.createdAt) return true;
          return since ? post.createdAt.isAfter(since) : true;
        },
      ]),
    );

    const filteredCount =
      getMediaCounts(twitterPosts) - getMediaCounts(filteredPosts);
    skipCount += filteredCount;
    log().info('FilteredPosts', filteredPosts);

    if (filteredPosts.length === 0) {
      updateCreationTask({
        ...task,
        completeCount,
        skipCount,
      });
      continue;
    }

    const paramsList: CreateDownloadTaskParams[] = [];

    for (const post of filteredPosts) {
      const filteredMedias = post.medias!.filter(
        R.allPass([
          (media) => {
            if (!filter.mediaTypes) return false;
            return filter.mediaTypes.includes(media.type);
          },
        ]),
      );

      log().info('FilteredMedias', filteredMedias);
      for (const media of filteredMedias) {
        const task = await prepareDownloadTask({ post, media });
        log().info('Prepared download task', task);
        const filePath = await path.join(task.dir, task.fileName);
        log().info('Resolved file path', filePath);
        if (settings.download.sameFileSkip && (await fs.exists(filePath))) {
          skipCount++;
          log().info('Skip because sameFileSkip', media);
          continue;
        }
        paramsList.push({
          media,
          post,
        });
      }
    }

    log().info('Params', paramsList);

    if (paramsList.length === 0) {
      updateCreationTask({
        ...task,
        completeCount,
        skipCount,
      });
      continue;
    }

    await batchCreateDownloadTask(paramsList);
    completeCount += paramsList.length;
    updateCreationTask({
      ...task,
      completeCount,
      skipCount,
    });

    if (abortSignal.aborted) break;
  }
}

// Schedules creation tasks
async function scheduleCreationTasks() {
  const { creationTasks, removeCreationTask, updateCreationTask } =
    useDownloadStore.getState();

  if (R.isEmpty(creationTasks)) {
    requestIdleCallback(scheduleCreationTasks);
    return;
  }

  // Check if there was a creation task running
  if (creationTasks.find((task) => task.status === 'active')) {
    requestIdleCallback(scheduleCreationTasks);
    return;
  }

  // Pick one waiting task from head
  const task = R.head(creationTasks) as CreationTask;
  const abortController = creationTaskAbortControllerMap.get(
    task.id,
  ) as AbortController;

  if (abortController.signal.aborted) {
    log().info('Aborted creation task, remove it', task);
    removeCreationTask(task.id);
    requestIdleCallback(scheduleCreationTasks);
    return;
  }

  task.status = 'active';
  updateCreationTask(task);

  try {
    await runCreationTask(task, abortController.signal);
    log().info('Completed creation task, remove it', task);
    removeCreationTask(task.id);
  } catch (err: any) {
    log().error('runCreationTaskError', err);
    removeCreationTask(task.id);
    const reason = typeof err === 'string' ? err : err?.message || '未知原因';
    notification.sendNotification({
      title: '爬虫任务运行失败',
      body: reason,
    });
    antNotification.error({
      message: `爬虫任务运行失败：${reason}`,
    });
  }

  requestIdleCallback(scheduleCreationTasks);
}

scheduleCreationTasks();

const INTERVAL = 500;
// Auto sync tasks
async function scheduleAutoSyncTasks() {
  const ids = useDownloadStore.getState().autoSyncTaskIds;
  if (ids.length === 0) {
    setTimeout(scheduleAutoSyncTasks, INTERVAL);
    return;
  }

  const now = Date.now();
  const resultMap = await aria2.tellStatus(ids);
  const { downloadTasks, batchUpdateDownloadTasks } =
    useDownloadStore.getState();
  const newTasks = await Promise.all(
    downloadTasks.map<Promise<DownloadTask>>(async (oldTask) => {
      // Do not update status after someone updated it during query
      if (oldTask.updatedAt > now) return oldTask;
      if (!resultMap[oldTask.gid]) return oldTask;
      return mergeAriaStatusToDownloadTask(
        resultMap[oldTask.gid],
        oldTask,
        now,
      );
    }),
  );

  batchUpdateDownloadTasks(newTasks);

  setTimeout(scheduleAutoSyncTasks, INTERVAL);
}

scheduleAutoSyncTasks();
