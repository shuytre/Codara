// 渲染层入口
import { render } from 'solid-js/web';

import { App } from './App';
import './theme/codara.css';
import './theme/layout.css';

const root = document.getElementById('root');
if (root) {
  render(() => <App />, root);
}
