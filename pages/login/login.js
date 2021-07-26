Page({

  /**
   * 页面的初始数据
   */
  data: {

  },
  GetUserInfo(e) {
    wx.getUserProfile({
      desc:'正在获取',//不写不弹提示框
      success:function(res){
        console.log('获取成功: ',res)
        wx.setStorageSync('userinfo', res.userInfo)
        wx.navigateBack({
          delta: 1,
        })
      },
      fail:function(err){
        console.log("获取失败: ",err)
      }
    })
  },

  /**
   * 生命周期函数--监听页面加载
   */
  onLoad: function (options) {

  },

  /**
   * 生命周期函数--监听页面初次渲染完成
   */
  onReady: function () {

  },

  /**
   * 生命周期函数--监听页面显示
   */
  onShow: function () {

  },

  /**
   * 生命周期函数--监听页面隐藏
   */
  onHide: function () {

  },

  /**
   * 生命周期函数--监听页面卸载
   */
  onUnload: function () {

  },

  /**
   * 页面相关事件处理函数--监听用户下拉动作
   */
  onPullDownRefresh: function () {

  },

  /**
   * 页面上拉触底事件的处理函数
   */
  onReachBottom: function () {

  },

  /**
   * 用户点击右上角分享
   */
  onShareAppMessage: function () {

  }
})