import { Schema } from 'effect';

/**
 * Confluence API v2 type definitions
 * These schemas are used for both validation and type inference
 */

/**
 * User information
 */
export const UserSchema = Schema.Struct({
  accountId: Schema.String,
  displayName: Schema.optional(Schema.String),
  email: Schema.optional(Schema.String),
});
export type User = Schema.Schema.Type<typeof UserSchema>;

/**
 * Space information from Confluence API v2
 */
export const SpaceSchema = Schema.Struct({
  id: Schema.String,
  key: Schema.String,
  name: Schema.String,
  type: Schema.optional(Schema.String),
  status: Schema.optional(Schema.String),
  homepageId: Schema.optional(Schema.String),
  description: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        plain: Schema.optional(
          Schema.Struct({
            value: Schema.String,
          }),
        ),
      }),
    ),
  ),
  _links: Schema.optional(
    Schema.Struct({
      webui: Schema.optional(Schema.String),
    }),
  ),
});
export type Space = Schema.Schema.Type<typeof SpaceSchema>;

/**
 * List of spaces response
 */
export const SpacesResponseSchema = Schema.Struct({
  results: Schema.Array(SpaceSchema),
  _links: Schema.optional(
    Schema.Struct({
      next: Schema.optional(Schema.String),
    }),
  ),
});
export type SpacesResponse = Schema.Schema.Type<typeof SpacesResponseSchema>;

/**
 * Page version information
 */
export const VersionSchema = Schema.Struct({
  number: Schema.Number,
  createdAt: Schema.optional(Schema.String),
  authorId: Schema.optional(Schema.String),
});
export type Version = Schema.Schema.Type<typeof VersionSchema>;

/**
 * Page body content
 */
export const BodySchema = Schema.Struct({
  storage: Schema.optional(
    Schema.Struct({
      value: Schema.String,
      representation: Schema.optional(Schema.String),
    }),
  ),
});
export type Body = Schema.Schema.Type<typeof BodySchema>;

/**
 * Label information
 */
export const LabelSchema = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  prefix: Schema.optional(Schema.String),
});
export type Label = Schema.Schema.Type<typeof LabelSchema>;

/**
 * Page information from Confluence API v2
 */
export const PageSchema = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  spaceId: Schema.String,
  status: Schema.optional(Schema.String),
  parentId: Schema.optional(Schema.NullOr(Schema.String)),
  parentType: Schema.optional(Schema.NullOr(Schema.String)),
  authorId: Schema.optional(Schema.String),
  ownerId: Schema.optional(Schema.String),
  createdAt: Schema.optional(Schema.String),
  version: Schema.optional(VersionSchema),
  body: Schema.optional(BodySchema),
  _links: Schema.optional(
    Schema.Struct({
      webui: Schema.optional(Schema.String),
      editui: Schema.optional(Schema.String),
      tinyui: Schema.optional(Schema.String),
    }),
  ),
});
export type Page = Schema.Schema.Type<typeof PageSchema>;

/**
 * List of pages response
 */
export const PagesResponseSchema = Schema.Struct({
  results: Schema.Array(PageSchema),
  _links: Schema.optional(
    Schema.Struct({
      next: Schema.optional(Schema.String),
    }),
  ),
});
export type PagesResponse = Schema.Schema.Type<typeof PagesResponseSchema>;

/**
 * Labels response
 */
export const LabelsResponseSchema = Schema.Struct({
  results: Schema.Array(LabelSchema),
  _links: Schema.optional(
    Schema.Struct({
      next: Schema.optional(Schema.String),
    }),
  ),
});
export type LabelsResponse = Schema.Schema.Type<typeof LabelsResponseSchema>;

/**
 * Folder information from Confluence API v2
 */
export const FolderSchema = Schema.Struct({
  id: Schema.String,
  type: Schema.Literal('folder'),
  title: Schema.String,
  parentId: Schema.optional(Schema.NullOr(Schema.String)),
  parentType: Schema.optional(Schema.NullOr(Schema.String)),
  authorId: Schema.optional(Schema.String),
  ownerId: Schema.optional(Schema.String),
  createdAt: Schema.optional(Schema.Union(Schema.String, Schema.Number)),
  status: Schema.optional(Schema.String),
  version: Schema.optional(VersionSchema),
});
export type Folder = Schema.Schema.Type<typeof FolderSchema>;

/**
 * Content item - either a page or folder
 */
export type ContentItem = Page | Folder;

/**
 * Check if content item is a folder
 */
export function isFolder(item: ContentItem): item is Folder {
  return 'type' in item && item.type === 'folder';
}

/**
 * Error response for version conflicts (409)
 */
export interface VersionConflictResponse {
  version?: {
    number?: number;
  };
}

/**
 * Request body for updating a page
 */
export const UpdatePageRequestSchema = Schema.Struct({
  id: Schema.String,
  status: Schema.String,
  title: Schema.String,
  body: Schema.Struct({
    representation: Schema.Literal('storage'),
    value: Schema.String,
  }),
  version: Schema.Struct({
    number: Schema.Number,
    message: Schema.optional(Schema.String),
  }),
});
export type UpdatePageRequest = Schema.Schema.Type<typeof UpdatePageRequestSchema>;

/**
 * Request body for creating a new page
 */
export const CreatePageRequestSchema = Schema.Struct({
  spaceId: Schema.String,
  status: Schema.String,
  title: Schema.String,
  parentId: Schema.optional(Schema.String),
  body: Schema.Struct({
    representation: Schema.Literal('storage'),
    value: Schema.String,
  }),
});
export type CreatePageRequest = Schema.Schema.Type<typeof CreatePageRequestSchema>;

/**
 * Page with children tree structure (for building hierarchy)
 */
export interface PageTreeNode {
  page: Page;
  children: PageTreeNode[];
}

/**
 * Content tree node (page or folder with children)
 */
export interface ContentTreeNode {
  item: ContentItem;
  children: ContentTreeNode[];
}
