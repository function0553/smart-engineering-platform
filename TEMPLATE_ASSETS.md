# 受控运行模板

本仓库不包含用户施工照片、原始业务文档作者信息、服务器数据或手机草稿。以下运行模板保存在现有受控发布资产中，未经重新授权不上传代码仓库；不提供公共下载地址。

| 恢复到仓库内的路径 | SHA-256 | 字节数 |
|---|---|---|
| `server/templates/daily-report.docx` | `10285383ab791127c964589bf283b90be87b2d15e8520c73081f2a9568e90c7d` | 14199 |
| `server/templates/photo-archive.docx` | `61a67cd9930241d6aed530d2748b86abd5e85911d16c1e9b42826862ca9c1c5d` | 15062 |
| `server/templates/site-photo-a4-aligned.docx` | `e1f62d3e6d2ee2fb9f53976de062384a2d530e725babbde9644edc08691d9ec9` | 2027514 |
| `server/templates/supervision-daily.docx` | `e932ceb1d271258a87ed49dd1eec04349f9d48b89137054e336ec4fd9a66cc27` | 37522 |

由项目负责人从原部署备份或本次发布受控资产私下交付上述文件。保持相同路径，核对SHA-256后再启动服务或执行涉及Word的测试。

`server/templates/site-photo-ten-steps-roles.json` 与照片模板精确绑定，恢复不同文件会被生成器拒绝。禁止为通过校验而随意修改角色映射或哈希。照片模板含原始现场照片，其余原始模板含文档作者属性；此排除不修改线上模板或已有资料。

缺少模板时前端构建可运行，但服务启动和相关集成测试不能视为通过。本仓库不是独立完整的生产备份。
