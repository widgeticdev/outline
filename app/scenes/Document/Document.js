// @flow
import * as React from 'react';
import debounce from 'lodash/debounce';
import styled from 'styled-components';
import breakpoint from 'styled-components-breakpoint';
import { observable } from 'mobx';
import { observer, inject } from 'mobx-react';
import { withRouter, Prompt } from 'react-router-dom';
import type { Location } from 'react-router-dom';
import keydown from 'react-keydown';
import Flex from 'shared/components/Flex';
import {
  collectionUrl,
  updateDocumentUrl,
  documentMoveUrl,
  documentEditUrl,
  matchDocumentEdit,
  matchDocumentMove,
} from 'utils/routeHelpers';
import { uploadFile } from 'utils/uploadFile';
import { emojiToUrl } from 'utils/emoji';
import isInternalUrl from 'utils/isInternalUrl';

import Document from 'models/Document';
import Header from './components/Header';
import DocumentMove from './components/DocumentMove';
import UiStore from 'stores/UiStore';
import AuthStore from 'stores/AuthStore';
import DocumentsStore from 'stores/DocumentsStore';
import ErrorBoundary from 'components/ErrorBoundary';
import LoadingPlaceholder from 'components/LoadingPlaceholder';
import LoadingIndicator from 'components/LoadingIndicator';
import CenteredContent from 'components/CenteredContent';
import PageTitle from 'components/PageTitle';
import Search from 'scenes/Search';
import Error404 from 'scenes/Error404';
import ErrorOffline from 'scenes/ErrorOffline';

const AUTOSAVE_DELAY = 3000;
const IS_DIRTY_DELAY = 500;
const MARK_AS_VIEWED_AFTER = 3000;
const DISCARD_CHANGES = `
You have unsaved changes.
Are you sure you want to discard them?
`;
const UPLOADING_WARNING = `
Image are still uploading.
Are you sure you want to discard them?
`;

type Props = {
  match: Object,
  history: Object,
  location: Location,
  documents: DocumentsStore,
  newDocument?: boolean,
  auth: AuthStore,
  ui: UiStore,
};

@observer
class DocumentScene extends React.Component<Props> {
  viewTimeout: TimeoutID;
  getEditorText: () => string;

  @observable editorComponent;
  @observable document: ?Document;
  @observable newDocument: ?Document;
  @observable isUploading = false;
  @observable isSaving = false;
  @observable isPublishing = false;
  @observable isDirty = false;
  @observable notFound = false;
  @observable moveModalOpen: boolean = false;

  componentDidMount() {
    this.loadDocument(this.props);
    this.loadEditor();
  }

  componentWillReceiveProps(nextProps) {
    if (
      nextProps.match.params.documentSlug !==
      this.props.match.params.documentSlug
    ) {
      this.notFound = false;
      clearTimeout(this.viewTimeout);
      this.loadDocument(nextProps);
    }
  }

  componentWillUnmount() {
    clearTimeout(this.viewTimeout);
    this.props.ui.clearActiveDocument();
  }

  @keydown('m')
  goToMove(ev) {
    ev.preventDefault();
    if (this.document) this.props.history.push(documentMoveUrl(this.document));
  }

  loadDocument = async props => {
    if (props.newDocument) {
      this.document = new Document({
        collection: { id: props.match.params.id },
        parentDocument: new URLSearchParams(props.location.search).get(
          'parentDocument'
        ),
        title: '',
        text: '',
      });
    } else {
      const { shareId } = props.match.params;
      this.document = await this.props.documents.fetch(
        props.match.params.documentSlug,
        { shareId }
      );
      this.isDirty = false;

      const document = this.document;

      if (document) {
        this.props.ui.setActiveDocument(document);

        if (this.props.auth.user && !shareId) {
          if (!this.isEditing && document.publishedAt) {
            this.viewTimeout = setTimeout(document.view, MARK_AS_VIEWED_AFTER);
          }

          // Update url to match the current one
          this.props.history.replace(
            updateDocumentUrl(props.match.url, document.url)
          );
        }
      } else {
        // Render 404 with search
        this.notFound = true;
      }
    }
  };

  loadEditor = async () => {
    const EditorImport = await import('./components/Editor');
    this.editorComponent = EditorImport.default;
  };

  get isEditing() {
    const document = this.document;

    return !!(
      this.props.match.path === matchDocumentEdit ||
      (document && !document.id)
    );
  }

  handleCloseMoveModal = () => (this.moveModalOpen = false);
  handleOpenMoveModal = () => (this.moveModalOpen = true);

  onSave = async (
    options: { done?: boolean, publish?: boolean, autosave?: boolean } = {}
  ) => {
    let document = this.document;
    if (!document) return;

    // get the latest version of the editor text value
    const text = this.getEditorText ? this.getEditorText() : document.text;

    // prevent autosave if nothing has changed
    if (options.autosave && document.text.trim() === text.trim()) return;

    document.updateData({ text });
    if (!document.allowSave) return;

    // prevent autosave before anything has been written
    if (options.autosave && !document.title && !document.id) return;

    let isNew = !document.id;
    this.isSaving = true;
    this.isPublishing = !!options.publish;
    document = await document.save(options);
    this.isDirty = false;
    this.isSaving = false;
    this.isPublishing = false;

    if (options.done) {
      this.props.history.push(document.url);
      this.props.ui.setActiveDocument(document);
    } else if (isNew) {
      this.props.history.push(documentEditUrl(document));
      this.props.ui.setActiveDocument(document);
    }
  };

  autosave = debounce(() => {
    this.onSave({ done: false, autosave: true });
  }, AUTOSAVE_DELAY);

  updateIsDirty = debounce(() => {
    const document = this.document;

    this.isDirty =
      document && this.getEditorText().trim() !== document.text.trim();
  }, IS_DIRTY_DELAY);

  onImageUploadStart = () => {
    this.isUploading = true;
  };

  onImageUploadStop = () => {
    this.isUploading = false;
  };

  onChange = getEditorText => {
    this.getEditorText = getEditorText;
    this.updateIsDirty();
    this.autosave();
  };

  onDiscard = () => {
    let url;
    if (this.document && this.document.url) {
      url = this.document.url;
    } else {
      url = collectionUrl(this.props.match.params.id);
    }
    this.props.history.push(url);
  };

  onUploadImage = async (file: File) => {
    const result = await uploadFile(file);
    return result.url;
  };

  onSearchLink = async (term: string) => {
    const results = await this.props.documents.search(term);

    return results.map((result, index) => ({
      title: result.document.title,
      url: result.document.url,
    }));
  };

  onClickLink = (href: string) => {
    // on page hash
    if (href[0] === '#') {
      window.location.href = href;
      return;
    }

    if (isInternalUrl(href)) {
      // relative
      let navigateTo = href;

      // probably absolute
      if (href[0] !== '/') {
        try {
          const url = new URL(href);
          navigateTo = url.pathname + url.hash;
        } catch (err) {
          navigateTo = href;
        }
      }

      this.props.history.push(navigateTo);
    } else {
      window.open(href, '_blank');
    }
  };

  onShowToast = (message: string) => {
    this.props.ui.showToast(message, 'success');
  };

  render() {
    const { location, match } = this.props;
    const Editor = this.editorComponent;
    const isMoving = match.path === matchDocumentMove;
    const document = this.document;
    const isShare = match.params.shareId;

    if (this.notFound) {
      return navigator.onLine ? (
        isShare ? (
          <Error404 />
        ) : (
          <Search notFound />
        )
      ) : (
        <ErrorOffline />
      );
    }

    if (!document || !Editor) {
      return (
        <Container column auto>
          <PageTitle title={location.state ? location.state.title : ''} />
          <CenteredContent>
            <LoadingState />
          </CenteredContent>
        </Container>
      );
    }

    return (
      <ErrorBoundary>
        <Container key={document.id} isShare={isShare} column auto>
          {isMoving && <DocumentMove document={document} />}
          <PageTitle
            title={document.title.replace(document.emoji, '')}
            favicon={document.emoji ? emojiToUrl(document.emoji) : undefined}
          />
          {(this.isUploading || this.isSaving) && <LoadingIndicator />}

          <Container justify="center" column auto>
            {this.isEditing && (
              <React.Fragment>
                <Prompt when={this.isDirty} message={DISCARD_CHANGES} />
                <Prompt when={this.isUploading} message={UPLOADING_WARNING} />
              </React.Fragment>
            )}
            {!isShare && (
              <Header
                document={document}
                isDraft={document.isDraft}
                isEditing={this.isEditing}
                isSaving={this.isSaving}
                isPublishing={this.isPublishing}
                savingIsDisabled={!document.allowSave}
                history={this.props.history}
                onDiscard={this.onDiscard}
                onSave={this.onSave}
              />
            )}
            <MaxWidth column auto>
              <Editor
                titlePlaceholder="Start with a title…"
                bodyPlaceholder="…the rest is your canvas"
                defaultValue={document.text}
                pretitle={document.emoji}
                uploadImage={this.onUploadImage}
                onImageUploadStart={this.onImageUploadStart}
                onImageUploadStop={this.onImageUploadStop}
                onSearchLink={this.onSearchLink}
                onClickLink={this.onClickLink}
                onChange={this.onChange}
                onSave={this.onSave}
                onCancel={this.onDiscard}
                onShowToast={this.onShowToast}
                readOnly={!this.isEditing}
                toc
              />
            </MaxWidth>
          </Container>
        </Container>
      </ErrorBoundary>
    );
  }
}

const MaxWidth = styled(Flex)`
  padding: 0 16px;
  max-width: 100vw;
  width: 100%;
  height: 100%;

  ${breakpoint('tablet')`	
    padding: 0;
    margin: 12px auto;
    max-width: 46em;
  `};
`;

const Container = styled(Flex)`
  position: relative;
  margin-top: ${props => (props.isShare ? '50px' : '0')};
`;

const LoadingState = styled(LoadingPlaceholder)`
  margin: 40px 0;
`;

export default withRouter(inject('ui', 'auth', 'documents')(DocumentScene));
