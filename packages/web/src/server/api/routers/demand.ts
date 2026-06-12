import {
  existsSync,
  lstatSync,
  mkdirSync,
  realpathSync,
} from 'node:fs';
import { relative, resolve } from 'node:path';

import {
  approveDemandShape,
  type DemandShape,
  readDemandShapeFile,
  renderDemandShapeForRun,
  shapeDemand,
  writeDemandShapeFile,
  writeDemandShapeFiles,
} from '@tekon/core';

import type { ServerContext, DemandShapeInput, DemandApproveInput } from '../context.js';
import { ApiError } from '../errors.js';
import { assertSessionToken } from '../common.js';
import { redactObject } from '../redaction.js';

export function createDemandRouter(context: ServerContext) {
  return {
    async detail(input: { shapePath: string; token: string }) {
      assertSessionToken(context.projectContext, input.token);
      const shapePath = assertDemandShapePathInScope(context, input.shapePath);
      const shape = readDemandShapeFile(shapePath);
      return { shape: redactObject(shape) as DemandShape };
    },

    async shape(shapeInput: DemandShapeInput) {
      assertSessionToken(context.projectContext, shapeInput.token);
      const shape = shapeDemand({ text: shapeInput.demandText });
      assertDemandShapeStorageInScope(context, { create: true });
      const paths = writeDemandShapeFiles({
        repoPath: context.projectContext.projectRoot,
        shape,
      });
      return {
        shape,
        shapePath: paths.jsonPath,
        reviewPath: paths.markdownPath,
        runText: renderDemandShapeForRun(shape),
      };
    },

    async approve(approveInput: DemandApproveInput) {
      assertSessionToken(context.projectContext, approveInput.token);
      const shapePath = assertDemandShapePathInScope(
        context,
        approveInput.shapePath,
      );
      const approved = approveDemandShape(readDemandShapeFile(shapePath), {
        actor: approveInput.actor ?? 'web',
      });
      writeDemandShapeFile(shapePath, approved);
      return {
        shape: approved,
        shapePath,
      };
    },
  };
}

function assertDemandShapePathInScope(
  context: ServerContext,
  shapePath: string,
): string {
  const resolvedPath = resolve(shapePath);
  const demandsDir = assertDemandShapeStorageInScope(context, {
    create: false,
  });
  const pathFromDemands = relative(demandsDir, resolvedPath);
  if (
    pathFromDemands.startsWith('..') ||
    pathFromDemands === '' ||
    pathFromDemands.includes('..') ||
    !pathFromDemands.endsWith('.json')
  ) {
    throw new ApiError('BAD_REQUEST', 'Demand shape path is out of scope.');
  }
  if (!existsSync(demandsDir) || !existsSync(resolvedPath)) {
    throw new ApiError('BAD_REQUEST', 'Demand shape path is out of scope.');
  }
  if (lstatSync(resolvedPath).isSymbolicLink()) {
    throw new ApiError('BAD_REQUEST', 'Demand shape path is out of scope.');
  }
  const expectedDemandsDir = realpathSync(demandsDir);
  const realPathFromDemands = relative(
    expectedDemandsDir,
    realpathSync(resolvedPath),
  );
  if (realPathFromDemands.startsWith('..') || realPathFromDemands === '') {
    throw new ApiError('BAD_REQUEST', 'Demand shape path is out of scope.');
  }
  return resolvedPath;
}

function assertDemandShapeStorageInScope(
  context: ServerContext,
  options: { create: boolean },
): string {
  const dataDir = resolve(context.projectContext.dataDir);
  const demandsDir = resolve(dataDir, 'demands');
  if (!existsSync(dataDir)) {
    throw new ApiError('BAD_REQUEST', 'Demand shape path is out of scope.');
  }
  if (lstatSync(dataDir).isSymbolicLink()) {
    throw new ApiError('BAD_REQUEST', 'Demand shape path is out of scope.');
  }
  const expectedDataDir = resolve(
    realpathSync(context.projectContext.projectRoot),
    '.tekon',
  );
  const realDataDir = realpathSync(dataDir);
  if (realDataDir !== expectedDataDir) {
    throw new ApiError('BAD_REQUEST', 'Demand shape path is out of scope.');
  }
  if (existsSync(demandsDir) && lstatSync(demandsDir).isSymbolicLink()) {
    throw new ApiError('BAD_REQUEST', 'Demand shape path is out of scope.');
  }
  if (options.create) {
    mkdirSync(demandsDir, { recursive: true });
  }
  if (!existsSync(demandsDir)) {
    throw new ApiError('BAD_REQUEST', 'Demand shape path is out of scope.');
  }
  if (lstatSync(demandsDir).isSymbolicLink()) {
    throw new ApiError('BAD_REQUEST', 'Demand shape path is out of scope.');
  }
  if (realpathSync(demandsDir) !== resolve(realDataDir, 'demands')) {
    throw new ApiError('BAD_REQUEST', 'Demand shape path is out of scope.');
  }
  return demandsDir;
}
