import PropTypes from 'prop-types';
import React, { useState, useEffect } from 'react';
import { useSelector, useDispatch } from 'react-redux';
import {
  FormTextField,
  TextFieldSize,
  TextFieldType,
} from '../../component-library';

import { useI18nContext } from '../../../hooks/useI18nContext';
import * as actions from '../../../store/actions';
import ShowHideToggle from '../../ui/show-hide-toggle';
import BottomButtons from './bottom-buttons';

export default function PrivateKeyImportView({
  importAccountFunc,
  onActionComplete,
}) {
  const t = useI18nContext();
  const dispatch = useDispatch();
  const [privateKey, setPrivateKey] = useState('');
  const [showPrivateKey, setShowPrivateKey] = useState(false);

  const warning = useSelector((state) => state.appState.warning);

  useEffect(() => {
    return () => {
      dispatch(actions.hideWarning());
    };
  }, [dispatch]);

  function handleKeyPress(event) {
    if (privateKey !== '' && event.key === 'Enter') {
      event.preventDefault();
      _importAccountFunc();
    }
  }

  function _importAccountFunc() {
    importAccountFunc('privateKey', [privateKey]);
  }

  return (
    <>
      <FormTextField
        id="private-key-box"
        size={TextFieldSize.Lg}
        autoFocus
        helpText={warning}
        error
        label={t('pastePrivateKey')}
        value={privateKey}
        onChange={(event) => setPrivateKey(event.target.value)}
        inputProps={{
          onKeyPress: handleKeyPress,
        }}
        marginBottom={4}
        type={showPrivateKey ? TextFieldType.Text : TextFieldType.Password}
        textFieldProps={{
          endAccessory: (
            <ShowHideToggle
              shown={showPrivateKey}
              id="show-hide-private-key"
              title={t('privateKeyShow')}
              ariaLabelShown={t('privateKeyShown')}
              ariaLabelHidden={t('privateKeyHidden')}
              onChange={() => setShowPrivateKey(!showPrivateKey)}
            />
          ),
        }}
      />

      <BottomButtons
        importAccountFunc={_importAccountFunc}
        isPrimaryDisabled={privateKey === ''}
        onActionComplete={onActionComplete}
      />
    </>
  );
}

PrivateKeyImportView.propTypes = {
  /**
   * Function to import the account
   */
  importAccountFunc: PropTypes.func.isRequired,
  /**
   * Executes when the key is imported
   */
  onActionComplete: PropTypes.func.isRequired,
};
