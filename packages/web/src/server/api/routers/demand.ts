import {
  existsSync,
  lstatSync,
  mkdirSync,
  realpathSync,
} from 'node:fs';
import { relative, resolve } from 'node:path';

import {
  approveDraftShape,
  type DraftShape,
  readDraftShapeFile,
  renderDraftShapeForRun,
  shapeDraft,
  writeDraftShapeFile,
  writeDraftShapeFiles,
} from '@tekon/core';

import type {
  ServerContext,
  DraftShapeInput,
  DraftShapeApproveInput,
  DraftShapeDetailInput,
} from '../context.js';
import { ApiError } from '../errors.js';
import { assertSessionToken } from '../common.js';
import { redactObject } from '../redaction.js';

export function createDemandRouter(context: ServerContext) {
  return {
    async detail(input: DraftShapeDetailInput) {
      assertSessionToken(context.projectContext, input.token);
      const shapePath = assertDraftShapePathInScope(context, input.shapePath);
      const shape = readDraftShapeFile(shapePath);
      return { shape: redactObject(shape) as DraftShape };
    },

    async shape(shapeInput: DraftShapeInput) {
      assertSessionToken(context.projectContext, shapeInput.token);
      const shape = shapeDraft({ text: shapeInput.demandText });
      assertDraftShapeStorageInScope(context, { create: true });
      const paths = writeDraftShapeFiles({
        repoPath: context.projectContext.projectRoot,
        shape,
      });
      return {
        shape,
        shapePath: paths.jsonPath,
        reviewPath: paths.markdownPath,
        runText: renderDraftShapeForRun(shape),
      };
    },

    async approve(approveInput: DraftShapeApproveInput) {
      assertSessionToken(context.projectContext, approveInput.token);
      const shapePath = assertDraftShapePathInScope(
        context,
        approveInput.shapePath,
      );
      const approved = approveDraftShape(readDraftShapeFile(shapePath), {
        actor: approveInput.actor ?? 'web',
      });
      writeDraftShapeFile(shapePath, approved);
      return {
        shape: approved,
        shapePath,
      };
    },
  };
}

function assertDraftShapePathInScope(
  context: ServerContext,
  shapePath: string,
): string {
  const resolvedPath = resolve(shapePath);
  const draftsDir = assertDraftShapeStorageInScope(context, {
    create: false,
  });
  const pathFromDrafts = relative(draftsDir, resolvedPath);
  if (
    pathFromDrafts.startsWith('..') ||
    pathFromDrafts === '' ||
    pathFromDrafts.includes('..') ||
    !pathFromDrafts.endsWith('.json')
  ) {
    throw new ApiError('BAD_REQUEST', 'Draft shape path is out of scope.');
  }
  if (!existsSync(draftsDir) || !existsSync(resolvedPath)) {
    throw new ApiError('BAD_REQUEST', 'Draft shape path is out of scope.');
  }
  if (lstatSync(resolvedPath).isSymbolicLink()) {
    throw new ApiError('BAD_REQUEST', 'Draft shape path is out of scope.');
  }
  const expectedDraftsDir = realpathSync(draftsDir);
  const realPathFromDrafts = relative(
    expectedDraftsDir,
    realpathSync(resolvedPath),
  );
  if (realPathFromDrafts.startsWith('..') || realPathFromDrafts === '') {
    throw new ApiError('BAD_REQUEST', 'Draft shape path is out of scope.');
  }
  return resolvedPath;
}

function assertDraftShapeStorageInScope(
  context: ServerContext,
  options: { create: boolean },
): string {
  const dataDir = resolve(context.projectContext.dataDir);
  const draftsDir = resolve(dataDir, 'drafts');
  if (!existsSync(dataDir)) {
    throw new ApiError('BAD_REQUEST', 'Draft shape path is out of scope.');
  }
  if (lstatSync(dataDir).isSymbolicLink()) {
    throw new ApiError('BAD_REQUEST', 'Draft shape path is out of scope.');
  }
  const expectedDataDir = resolve(
    realpathSync(context.projectContext.projectRoot),
    '.tekon',
  );
  const realDataDir = realpathSync(dataDir);
  if (realDataDir !== expectedDataDir) {
    throw new ApiError('BAD_REQUEST', 'Draft shape path is out of scope.');
  }
  if (existsSync(draftsDir) && lstatSync(draftsDir).isSymbolicLink()) {
    throw new ApiError('BAD_REQUEST', 'Draft shape path is out of scope.');
  }
  if (options.create) {
    mkdirSync(draftsDir, { recursive: true });
  }
  if (!existsSync(draftsDir)) {
    throw new ApiError('BAD_REQUEST', 'Draft shape path is out of scope.');
  }
  if (lstatSync(draftsDir).isSymbolicLink()) {
    throw new ApiError('BAD_REQUEST', 'Draft shape path is out of scope.');
  }
  if (realpathSync(draftsDir) !== resolve(realDataDir, 'drafts')) {
    throw new ApiError('BAD_REQUEST', 'Draft shape path is out of scope.');
  }
  return draftsDir;
}
