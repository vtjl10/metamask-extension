import SmartTransactionsController, {
  SmartTransactionsControllerSmartTransactionEvent,
} from '@metamask/smart-transactions-controller';
import {
  Fee,
  Fees,
  SmartTransactionStatuses,
  SmartTransaction,
} from '@metamask/smart-transactions-controller/dist/types';
import type { Hex } from '@metamask/utils';
import {
  TransactionController,
  TransactionMeta,
  TransactionParams,
  TransactionType,
  type PublishBatchHookTransaction,
} from '@metamask/transaction-controller';
import log from 'loglevel';
import { RestrictedMessenger } from '@metamask/base-controller';
import {
  AddApprovalRequest,
  UpdateRequestState,
  StartFlow,
  EndFlow,
  AcceptRequest,
} from '@metamask/approval-controller';

import { decimalToHex } from '../../../../shared/modules/conversion.utils';
import { CANCEL_GAS_LIMIT_DEC } from '../../../../shared/constants/smartTransactions';
import { isLegacyTransaction } from '../../../../shared/modules/transaction.utils';
import {
  SMART_TRANSACTION_CONFIRMATION_TYPES,
  ORIGIN_METAMASK,
} from '../../../../shared/constants/app';

const namespace = 'SmartTransactions';

export type AllowedActions =
  | AddApprovalRequest
  | UpdateRequestState
  | StartFlow
  | AcceptRequest
  | EndFlow;
export type AllowedEvents = SmartTransactionsControllerSmartTransactionEvent;

export type SmartTransactionHookMessenger = RestrictedMessenger<
  typeof namespace,
  AllowedActions,
  AllowedEvents,
  AllowedActions['type'],
  AllowedEvents['type']
>;

export type FeatureFlags = {
  extensionActive: boolean;
  mobileActive: boolean;
  smartTransactions: {
    expectedDeadline?: number;
    maxDeadline?: number;
    extensionReturnTxHashAsap?: boolean;
  };
};

export type SubmitSmartTransactionRequest = {
  transactionMeta: TransactionMeta;
  signedTransactionInHex?: string;
  smartTransactionsController: SmartTransactionsController;
  transactionController: TransactionController;
  isSmartTransaction: boolean;
  controllerMessenger: SmartTransactionHookMessenger;
  featureFlags: FeatureFlags;
  transactions?: PublishBatchHookTransaction[];
};

class SmartTransactionHook {
  // Static property to store the approval flow ID across instances
  static #sharedApprovalFlowId = '';

  #approvalFlowEnded: boolean;

  #approvalFlowId: string;

  #chainId: Hex;

  #controllerMessenger: SmartTransactionHookMessenger;

  #featureFlags: {
    extensionActive: boolean;
    mobileActive: boolean;
    smartTransactions: {
      expectedDeadline?: number;
      maxDeadline?: number;
      extensionReturnTxHashAsap?: boolean;
    };
  };

  #isDapp: boolean;

  #isSmartTransaction: boolean;

  #smartTransactionsController: SmartTransactionsController;

  #transactionController: TransactionController;

  #transactionMeta: TransactionMeta;

  #signedTransactionInHex?: string;

  #transactions?: PublishBatchHookTransaction[];

  #txParams: TransactionParams;

  #shouldShowStatusPage: boolean;

  constructor(request: SubmitSmartTransactionRequest) {
    const {
      transactionMeta,
      signedTransactionInHex,
      smartTransactionsController,
      transactionController,
      isSmartTransaction,
      controllerMessenger,
      featureFlags,
      transactions,
    } = request;
    this.#approvalFlowId = '';
    this.#approvalFlowEnded = false;
    this.#transactionMeta = transactionMeta as TransactionMeta;
    this.#signedTransactionInHex = signedTransactionInHex;
    this.#smartTransactionsController = smartTransactionsController;
    this.#transactionController = transactionController;
    this.#isSmartTransaction = isSmartTransaction;
    this.#controllerMessenger = controllerMessenger;
    this.#featureFlags = featureFlags;
    this.#isDapp = transactionMeta.origin !== ORIGIN_METAMASK;
    this.#chainId = transactionMeta.chainId;
    this.#txParams = transactionMeta.txParams;
    this.#transactions = transactions;
    this.#shouldShowStatusPage = Boolean(
      transactionMeta.type !== TransactionType.bridge ||
        (this.#transactions && this.#transactions.length > 0),
    );
  }

  async submit() {
    const isUnsupportedTransactionTypeForSmartTransaction = this
      .#transactionMeta.type
      ? [
          TransactionType.swapAndSend,
          TransactionType.swapApproval,
          TransactionType.bridgeApproval,
        ].includes(this.#transactionMeta.type)
      : false;

    // Will cause TransactionController to publish to the RPC provider as normal.
    const useRegularTransactionSubmit = { transactionHash: undefined };
    if (
      !this.#isSmartTransaction ||
      isUnsupportedTransactionTypeForSmartTransaction ||
      isLegacyTransaction(this.#transactionMeta)
    ) {
      return useRegularTransactionSubmit;
    }

    if (this.#shouldShowStatusPage) {
      await this.#startApprovalFlow();
    }
    let getFeesResponse;
    try {
      getFeesResponse = await this.#smartTransactionsController.getFees(
        { ...this.#txParams, chainId: this.#chainId },
        undefined,
      );
    } catch (error) {
      log.error(
        'Error in smart transaction publish hook, falling back to regular transaction submission',
        error,
      );
      this.#onApproveOrReject();
      return useRegularTransactionSubmit; // Fallback to regular transaction submission.
    }
    try {
      const submitTransactionResponse = await this.#signAndSubmitTransactions({
        getFeesResponse,
      });

      const uuid = submitTransactionResponse?.uuid;
      if (!uuid) {
        throw new Error('No smart transaction UUID');
      }

      await this.#processApprovalIfNeeded(uuid);

      const extensionReturnTxHashAsap =
        this.#featureFlags?.smartTransactions?.extensionReturnTxHashAsap;

      let transactionHash: string | undefined | null;
      if (extensionReturnTxHashAsap && submitTransactionResponse?.txHash) {
        transactionHash = submitTransactionResponse.txHash;
      } else {
        transactionHash = await this.#waitForTransactionHash({
          uuid,
        });
      }

      if (transactionHash === null) {
        throw new Error(
          'Transaction does not have a transaction hash, there was a problem',
        );
      }
      return { transactionHash };
    } catch (error) {
      log.error('Error in smart transaction publish hook', error);
      this.#onApproveOrReject();
      throw error;
    }
  }

  async submitBatch() {
    // Will cause TransactionController to publish to the RPC provider as normal.
    const useRegularTransactionSubmit = undefined;

    if (!this.#isSmartTransaction) {
      return useRegularTransactionSubmit;
    }

    if (this.#shouldShowStatusPage) {
      await this.#startApprovalFlow();
    }

    try {
      const submitTransactionResponse = await this.#signAndSubmitTransactions();
      const uuid = submitTransactionResponse?.uuid;

      if (!uuid) {
        throw new Error('No smart transaction UUID');
      }

      await this.#processApprovalIfNeeded(uuid);

      const transactionHash = await this.#waitForTransactionHash({
        uuid,
      });

      if (transactionHash === null) {
        throw new Error(
          'Transaction does not have a transaction hash, there was a problem',
        );
      }

      let submitBatchResponse;
      if (submitTransactionResponse?.txHashes) {
        submitBatchResponse = {
          results: submitTransactionResponse.txHashes.map((txHash: string) => ({
            transactionHash: txHash,
          })),
        };
      } else {
        submitBatchResponse = {
          results: [],
        };
      }

      return submitBatchResponse;
    } catch (error) {
      log.error('Error in smart transaction publish batch hook', error);
      this.#onApproveOrReject();
      throw error;
    }
  }

  /**
   * Ends an existing approval flow and clears the shared approval flow ID
   *
   * @param approvalFlowId - The ID of the approval flow to end
   * @returns Promise that resolves when the flow is successfully ended or errors are handled
   */
  async #endExistingApprovalFlow(approvalFlowId: string): Promise<void> {
    try {
      // End the existing flow
      await this.#controllerMessenger.call('ApprovalController:endFlow', {
        id: approvalFlowId,
      });

      // Accept the request to close the UI
      await this.#controllerMessenger.call(
        'ApprovalController:acceptRequest',
        approvalFlowId,
      );

      SmartTransactionHook.#sharedApprovalFlowId = '';
    } catch (error) {
      log.error('Error ending existing approval flow', error);
    }
  }

  async #startApprovalFlow() {
    if (SmartTransactionHook.#sharedApprovalFlowId) {
      await this.#endExistingApprovalFlow(
        SmartTransactionHook.#sharedApprovalFlowId,
      );
    }

    // Create a new approval flow
    const { id: approvalFlowId } = await this.#controllerMessenger.call(
      'ApprovalController:startFlow',
    );

    // Store the flow ID both in the instance and in the static property
    this.#approvalFlowId = approvalFlowId;
    SmartTransactionHook.#sharedApprovalFlowId = approvalFlowId;
  }

  async #processApprovalIfNeeded(uuid: string) {
    if (this.#shouldShowStatusPage) {
      this.#addApprovalRequest({
        uuid,
      });
      this.#addListenerToUpdateStatusPage({
        uuid,
      });
    }
  }

  #onApproveOrReject() {
    if (!this.#shouldShowStatusPage || this.#approvalFlowEnded) {
      return;
    }
    this.#approvalFlowEnded = true;
    try {
      this.#controllerMessenger.call('ApprovalController:endFlow', {
        id: this.#approvalFlowId,
      });
    } catch (error) {
      // If the flow is already ended, we can ignore the error.
    }

    // Clear the shared approval flow ID when we end the flow
    if (SmartTransactionHook.#sharedApprovalFlowId === this.#approvalFlowId) {
      SmartTransactionHook.#sharedApprovalFlowId = '';
    }
  }

  #addApprovalRequest({ uuid }: { uuid: string }) {
    const onApproveOrRejectWrapper = () => {
      this.#onApproveOrReject();
    };
    this.#controllerMessenger
      .call(
        'ApprovalController:addRequest',
        {
          id: this.#approvalFlowId,
          origin,
          type: SMART_TRANSACTION_CONFIRMATION_TYPES.showSmartTransactionStatusPage,
          requestState: {
            smartTransaction: {
              status: SmartTransactionStatuses.PENDING,
              creationTime: Date.now(),
              uuid,
            },
            isDapp: this.#isDapp,
            txId: this.#transactionMeta.id,
          },
        },
        true,
      )
      .then(onApproveOrRejectWrapper, onApproveOrRejectWrapper);
  }

  async #updateApprovalRequest({
    smartTransaction,
  }: {
    smartTransaction: SmartTransaction;
  }) {
    return await this.#controllerMessenger.call(
      'ApprovalController:updateRequestState',
      {
        id: this.#approvalFlowId,
        requestState: {
          smartTransaction,
          isDapp: this.#isDapp,
          txId: this.#transactionMeta.id,
        },
      },
    );
  }

  async #addListenerToUpdateStatusPage({ uuid }: { uuid: string }) {
    this.#controllerMessenger.subscribe(
      'SmartTransactionsController:smartTransaction',
      async (smartTransaction: SmartTransaction) => {
        if (smartTransaction.uuid === uuid) {
          const { status } = smartTransaction;
          if (!status || status === SmartTransactionStatuses.PENDING) {
            return;
          }
          if (!this.#approvalFlowEnded) {
            await this.#updateApprovalRequest({
              smartTransaction,
            });
          }
        }
      },
    );
  }

  #waitForTransactionHash({ uuid }: { uuid: string }): Promise<string | null> {
    return new Promise((resolve) => {
      this.#controllerMessenger.subscribe(
        'SmartTransactionsController:smartTransaction',
        async (smartTransaction: SmartTransaction) => {
          if (smartTransaction.uuid === uuid) {
            const { status, statusMetadata } = smartTransaction;
            if (!status || status === SmartTransactionStatuses.PENDING) {
              return;
            }
            log.debug('Smart Transaction: ', smartTransaction);
            if (statusMetadata?.minedHash) {
              log.debug(
                'Smart Transaction - Received tx hash: ',
                statusMetadata?.minedHash,
              );
              resolve(statusMetadata.minedHash);
            } else {
              resolve(null);
            }
          }
        },
      );
    });
  }

  async #signAndSubmitTransactions({
    getFeesResponse,
  }: {
    getFeesResponse?: Fees;
  } = {}) {
    let signedTransactions: string[] = [];

    if (
      this.#transactions &&
      Array.isArray(this.#transactions) &&
      this.#transactions.length > 0
    ) {
      // Batch transaction mode - extract signed transactions from this.#transactions[].signedTx
      signedTransactions = this.#transactions
        .filter((tx) => tx?.signedTx)
        .map((tx) => tx.signedTx);
    } else if (this.#signedTransactionInHex) {
      // Single transaction mode with pre-signed transaction
      signedTransactions = [this.#signedTransactionInHex];
    } else if (getFeesResponse) {
      // Single transaction mode requiring signing
      signedTransactions = await this.#createSignedTransactions(
        getFeesResponse.tradeTxFees?.fees ?? [],
        false,
      );
    }

    return await this.#smartTransactionsController.submitSignedTransactions({
      signedTransactions,
      signedCanceledTransactions: [],
      txParams: this.#txParams,
      transactionMeta: this.#transactionMeta,
    });
  }

  #applyFeeToTransaction(fee: Fee, isCancel: boolean): TransactionParams {
    if (!this.#txParams) {
      throw new Error('Transaction params are required');
    }

    const unsignedTransaction = {
      ...this.#txParams,
      maxFeePerGas: `0x${decimalToHex(fee.maxFeePerGas)}`,
      maxPriorityFeePerGas: `0x${decimalToHex(fee.maxPriorityFeePerGas)}`,
      gas: isCancel
        ? `0x${decimalToHex(CANCEL_GAS_LIMIT_DEC)}` // It has to be 21000 for cancel transactions, otherwise the API would reject it.
        : this.#txParams.gas,
    } as TransactionParams;

    if (isCancel) {
      unsignedTransaction.to = unsignedTransaction.from;
      unsignedTransaction.data = '0x';
    }

    return unsignedTransaction;
  }

  async #createSignedTransactions(
    fees: Fee[],
    isCancel: boolean,
  ): Promise<string[]> {
    if (!this.#txParams || !this.#chainId) {
      throw new Error('Transaction params and chainId are required');
    }

    const unsignedTransactions = fees.map((fee) => {
      return this.#applyFeeToTransaction(fee, isCancel);
    });

    const transactionsWithChainId = unsignedTransactions.map((tx) => ({
      ...tx,
      chainId: tx.chainId || this.#chainId,
    }));

    return (await this.#transactionController.approveTransactionsWithSameNonce(
      transactionsWithChainId as (TransactionParams & { chainId: Hex })[],
      { hasNonce: true },
    )) as string[];
  }
}

export const submitSmartTransactionHook = (
  request: SubmitSmartTransactionRequest,
) => {
  const smartTransactionHook = new SmartTransactionHook(request);
  return smartTransactionHook.submit();
};

export const submitBatchSmartTransactionHook = (
  request: SubmitSmartTransactionRequest,
) => {
  const smartTransactionHook = new SmartTransactionHook(request);
  return smartTransactionHook.submitBatch();
};
